/** The warning for tags of the old `deployed/<app>` layout in `tagLines`, or undefined when there are none. */
export function legacyTagWarning(tagLines: string): string | undefined {
  const legacy = tagLines.split("\n").filter((line) => /\trefs\/tags\/deployed\/[^/]+$/.test(line))
  if (legacy.length === 0) return undefined
  return `${legacy.length} deployed/<app> tag(s) of the old layout are not read; their images are not protected`
}
