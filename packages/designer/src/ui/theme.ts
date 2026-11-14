import { useEffect, useState } from 'react';

export type EditorTheme = 'light' | 'dark' | null;

/** What the editor says its theme is, from the classes VS Code puts on the webview body. Null means: follow the system. */
export function readEditorTheme(body: HTMLElement): EditorTheme {
  const classes = body.classList;
  if (classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light')) return 'light';
  if (classes.contains('vscode-dark') || classes.contains('vscode-high-contrast')) return 'dark';
  return null;
}

/**
 * Follows the editor's theme. Sets `data-fw-theme` on the page, which the `--fw-*` tokens answer
 * to. With no editor theme the tokens follow `prefers-color-scheme` on their own.
 */
export function useEditorTheme(): EditorTheme {
  const [theme, setTheme] = useState<EditorTheme>(() => readEditorTheme(document.body));
  useEffect(() => {
    const update = (): void => setTheme(readEditorTheme(document.body));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.fwTheme = theme;
    else delete root.dataset.fwTheme;
  }, [theme]);
  return theme;
}
