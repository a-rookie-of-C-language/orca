import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

for (const theme of ['light', 'dark'] as const) {
  test(`compact explorer loads JetBrains icons and nested rows (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(async (theme) => {
      await window.__store?.getState().updateSettings({ theme })
    }, theme)
    await openFileExplorer(orcaPage)

    const explorer = orcaPage.locator('[data-orca-explorer-shell]')
    const rows = explorer.locator('[data-file-explorer-row]')
    const folder = rows.filter({ has: orcaPage.getByText('src', { exact: true }) }).first()
    await expect(folder).toBeVisible()
    await expect(folder).toHaveCSS('height', '22px')
    if ((await folder.getAttribute('aria-expanded')) !== 'true') {
      await folder.click()
    }
    await expect(folder).toHaveAttribute('aria-expanded', 'true')

    const file = rows.filter({ has: orcaPage.getByText('index.ts', { exact: true }) }).first()
    await expect(file).toBeVisible()
    await expect(file).toHaveCSS('height', '22px')
    await expect(file.locator('[data-file-explorer-indent-guides]')).toBeVisible()
    const folderIndent = await folder.evaluate((row) =>
      Number.parseFloat(getComputedStyle(row).paddingLeft)
    )
    const fileIndent = await file.evaluate((row) =>
      Number.parseFloat(getComputedStyle(row).paddingLeft)
    )
    expect(fileIndent - folderIndent).toBe(12)

    for (const row of [folder, file]) {
      const icon = row.locator('[data-workspace-file-icon] img:visible')
      await expect(icon).toHaveCount(1)
      await expect
        .poll(() =>
          icon.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
        )
        .toBe(true)
      await expect(icon).toHaveCSS('width', '16px')
    }
    await file.click()
    await expect(file).toHaveAttribute('data-selected', 'true')

    const bounds = await explorer.boundingBox()
    if (!bounds) {
      throw new Error('Expected a measurable file explorer')
    }
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    try {
      const screenshot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...bounds, height: Math.min(bounds.height, 420), scale: 1 }
      })
      const screenshotPath = testInfo.outputPath(`file-explorer-${theme}.png`)
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
      await testInfo.attach(`File explorer (${theme})`, {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      await cdp.detach()
    }
  })
}
