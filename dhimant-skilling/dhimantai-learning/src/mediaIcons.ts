/** Shared device states for the initial desktop markup and live controls. */
export function mediaIcon(device: 'microphone' | 'camera' | 'speaker', enabled: boolean) {
  const paths = {
    microphone: enabled
      ? 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8'
      : 'M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8',
    camera: enabled
      ? 'M3 6h12v12H3ZM15 10l6-4v12l-6-4'
      : 'M9 6h6v4l6-4v12l-3-2M15 15v3H3V6h3',
    speaker: enabled
      ? 'M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14'
      : 'M11 4 8 7M6 8H3v8h3l5 4v-9',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[device]}"/>${enabled ? '' : '<path d="M3 3l18 18"/>'}</svg>`;
}
