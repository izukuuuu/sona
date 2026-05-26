'use client';

import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

/**
 * Lobe ThemeProvider uses antd-style/emotion; SSR markup order differs from the client.
 * Mount theme only after hydration to avoid mismatch (see ant-app vs emotion global style).
 * ConfigProvider (motion) must wrap the tree on every render — Lobe UI components require it.
 */
export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    setThemeReady(true);
  }, []);

  if (!themeReady) {
    return (
      <div className="sonaProvidersShell" suppressHydrationWarning style={{ display: 'contents' }}>
        <ConfigProvider motion={motion}>{children}</ConfigProvider>
      </div>
    );
  }

  return (
    <ConfigProvider motion={motion}>
      <ThemeProvider
        customTheme={{
          neutralColor: 'slate',
          primaryColor: 'cyan',
        }}
        enableCustomFonts={false}
        themeMode="light"
      >
        {children}
      </ThemeProvider>
    </ConfigProvider>
  );
}
