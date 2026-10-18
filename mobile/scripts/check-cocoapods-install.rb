require "bundler"
require "fileutils"
require "open3"
require "tmpdir"
require "yaml"
require "xcodeproj"

abort "Run this check on macOS with Xcode installed" unless RUBY_PLATFORM.include?("darwin")

gemfile = File.expand_path("../Gemfile", __dir__)
lockfile = "#{gemfile}.lock"
original_lock = File.binread(lockfile)
locked_version = Bundler.definition.locked_gems.specs.find { |spec| spec.name == "cocoapods" }.version.to_s

def run!(env, *command, chdir:)
  output, status = Open3.capture2e(env, *command, chdir: chdir)
  puts output
  abort "#{command.join(' ')} failed" unless status.success?
end

Dir.mktmpdir("orca-cocoapods-") do |directory|
  ios = File.join(directory, "ios")
  pod = File.join(directory, "FixturePod")
  FileUtils.mkdir_p([ios, pod])
  project = Xcodeproj::Project.new(File.join(ios, "InstallerCheck.xcodeproj"))
  project.new_target(:application, "InstallerCheck", :ios, "15.1")
  project.save
  File.write(File.join(pod, "FixturePod.h"), "void orca_installer_fixture(void);\n")
  File.write(File.join(pod, "FixturePod.podspec"), <<~PODSPEC)
    Pod::Spec.new do |spec|
      spec.name = 'FixturePod'
      spec.version = '1.0.0'
      spec.summary = 'Local installer check'
      spec.homepage = 'https://example.invalid'
      spec.license = { :type => 'MIT' }
      spec.author = 'Orca'
      spec.source = { :git => 'https://example.invalid/unused.git' }
      spec.source_files = '*.h'
      spec.ios.deployment_target = '15.1'
    end
  PODSPEC
  File.write(File.join(ios, "Podfile"), <<~PODFILE)
    platform :ios, '15.1'
    target 'InstallerCheck' do
      pod 'FixturePod', :path => '../FixturePod'
    end
  PODFILE

  env = {
    "BUNDLE_GEMFILE" => gemfile,
    "BUNDLE_FROZEN" => "true",
    "COCOAPODS_DISABLE_STATS" => "true"
  }
  # Exercise the release command in an ios directory, using only a local pod.
  run!(env, "bundle", "exec", "pod", "install", chdir: ios)
  installed = YAML.safe_load(File.read(File.join(ios, "Podfile.lock")), permitted_classes: [Symbol])
  abort "CocoaPods version differs from Gemfile.lock" unless installed.fetch("COCOAPODS") == locked_version
  installed_spec = File.join(ios, "Pods", "Local Podspecs", "FixturePod.podspec.json")
  abort "Local pod was not installed" unless File.exist?(installed_spec)
  abort "Xcode workspace was not generated" unless File.directory?(File.join(ios, "InstallerCheck.xcworkspace"))

  # A changed tool manifest must fail instead of silently resolving a new installer.
  changed_gemfile = File.join(directory, "Gemfile")
  File.write(changed_gemfile, File.read(gemfile) + "\ngem 'orca-installer-missing-fixture', '= 0.0.0'\n")
  FileUtils.cp(lockfile, "#{changed_gemfile}.lock")
  output, status = Open3.capture2e(env.merge("BUNDLE_GEMFILE" => changed_gemfile), "bundle", "check", chdir: ios)
  abort "Frozen Bundler accepted a changed Gemfile" if status.success?
  unless output.include?("frozen") && output.include?("orca-installer-missing-fixture")
    abort "Bundler failed for an unexpected reason: #{output}"
  end
end

abort "Installer check modified Gemfile.lock" unless File.binread(lockfile) == original_lock
puts "Locked CocoaPods #{locked_version} installed a local pod; frozen manifest drift was rejected."
