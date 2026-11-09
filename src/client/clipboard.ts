/**
 * Clipboard write with a selection fallback.
 *
 * The plugin runs inside the DSH web shell, where `navigator.clipboard` may be
 * absent on a non-secure origin or refused by permissions policy. A hidden
 * textarea plus `execCommand('copy')` is the only fallback that still works
 * there; both paths are best effort and never throw.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection path.
  }
  if (typeof document === 'undefined') return false
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
