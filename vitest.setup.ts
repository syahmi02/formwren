// jsdom has no CSS.escape, and React Aria calls it for keyboard handling and popovers.
const scope = globalThis as unknown as { window?: unknown; CSS?: { escape?: (value: string) => string } };

if (scope.window) {
  scope.CSS ??= {};
  scope.CSS.escape ??= (value) => value.replace(/[^\w-]/g, (character) => '\\' + character);
}

export {};
