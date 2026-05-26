'use client';

import { ThemeProvider } from '@lobehub/ui';
import { useEffect, useState } from 'react';

/**
 * Lobe ThemeProvider uses antd-style/emotion; SSR markup order differs from the client.
 * Mount theme only after hydration to avoid mismatch (see ant-app vs emotion global style).
 */
export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    setThemeReady(true);
  }, []);

  if (!themeReady) {
    return (
      <div className="sonaProvidersShell" suppressHydrationWarning style={{ display: 'contents' }}>
        {children}
      </div>
    );
  }

  return (
    <ThemeProvider
      customTheme={{
        neutralColor: 'slate',
        primaryColor: 'blue',
      }}
      enableCustomFonts={false}
      themeMode="light"
    >
      {children}
    </ThemeProvider>
  );
}
