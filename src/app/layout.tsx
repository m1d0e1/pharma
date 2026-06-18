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


import { Cairo, Inter } from 'next/font/google'
import AppInitializer from '@/components/AppInitializer'

const cairo = Cairo({
  subsets: ['arabic'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-cairo',
})

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-inter',
})

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ar" dir="rtl" className={`scroll-smooth ${cairo.variable} ${inter.variable}`} suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <AppInitializer>
          {children}
        </AppInitializer>
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
