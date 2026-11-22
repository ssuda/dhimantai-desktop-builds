const assignedHues = new Map<string, number>([
  ['build-an-llm', 292], ['build-ai-agents', 257],
  ['agentic-ai-applications', 158], ['llm-apis-tools-mcp', 350],
  ['erpnext-essentials', 195], ['cybersecurity-awareness', 345], ['ai-at-work', 70],
]);

/** IDs drive the colour so searching or reordering courses keeps their accent. */
export function courseHue(id: string) {
  const assigned = assignedHues.get(id);
  if (assigned !== undefined) return assigned;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 36000) / 100;
}

/** Nonced stylesheet rules for the webviews, using only numeric hue values in selectors. */
export function courseHueStyles(courseIds: string[]) {
  const hues = new Set(courseIds.map(courseHue));
  return Array.from(hues, hue => `[data-course-hue="${hue}"]{--course-hue:${hue}}`).join('\n');
}
