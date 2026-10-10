export function cleanMetadataText(value: string): string {
  return value.replace(/\0/g, '').trim();
}
