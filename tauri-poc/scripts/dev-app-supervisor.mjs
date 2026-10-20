export const DEV_RESTART_EXIT_CODE = 75

export function superviseDevelopmentApp({ launch, stopVite, owner = process }) {
  let child
  let stopping = false

  const finish = (code) => {
    if (stopping) {
      return
    }
    stopping = true
    stopVite()
    owner.exitCode = code
  }

  const start = () => {
    if (stopping) {
      return
    }
    try {
      child = launch()
    } catch (error) {
      console.error(`Could not start Tauri: ${error.message}`)
      finish(1)
      return
    }
    child.once('error', (error) => {
      console.error(`Could not start Tauri: ${error.message}`)
      finish(1)
    })
    child.once('exit', (code, signal) => {
      if (stopping) {
        return
      }
      if (!signal && code === DEV_RESTART_EXIT_CODE) {
        start()
      } else {
        finish(signal ? 1 : (code ?? 1))
      }
    })
  }

  start()
  return {
    stop(signal) {
      if (stopping) {
        return
      }
      stopping = true
      stopVite()
      child?.kill(signal)
    }
  }
}
