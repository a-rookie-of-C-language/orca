// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WebTabletShell } from './web-tablet-shell'

function stubIpadNavigator(): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'
  })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
}

describe('WebTabletShell', () => {
  it('marks the document as tablet on the pairing screen', () => {
    stubIpadNavigator()
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia

    const { unmount } = render(
      <WebTabletShell>
        <div>pairing</div>
      </WebTabletShell>
    )

    expect(document.documentElement).toHaveClass('web-tablet')
    unmount()
    expect(document.documentElement).not.toHaveClass('web-tablet')
  })
})
