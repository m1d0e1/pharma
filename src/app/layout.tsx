import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Toaster } from 'react-hot-toast'

export const metadata: Metadata = {
  title: 'فارما تيك - نظام إدارة الصيدليات',
  description: 'نظام إدارة صيدليات متكامل وذكي',
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  themeColor: '#3b82f6',
  width: 'device-width',
  initialScale: 1,
}

import AppInitializer from '@/components/AppInitializer'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ar" dir="rtl" className="scroll-smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            if (typeof window !== 'undefined' && window.location.pathname.endsWith('.html')) {
              var cleanPath = window.location.pathname;
              if (cleanPath.endsWith('/index.html')) {
                cleanPath = cleanPath.slice(0, -11) || '/';
              } else {
                cleanPath = cleanPath.slice(0, -5);
              }
              window.history.replaceState(null, '', cleanPath);
            }
          })();
        ` }} />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <AppInitializer>
          {children}
        </AppInitializer>
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
