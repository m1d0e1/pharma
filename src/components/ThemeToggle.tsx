'use client'

import { useState, useEffect } from 'react'
import { Moon, Sun } from 'lucide-react'

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null
    if (savedTheme) {
      setTheme(savedTheme)
      document.documentElement.classList.toggle('dark', savedTheme === 'dark')
    } else {
      setTheme('light')
      document.documentElement.classList.remove('dark')
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    document.documentElement.classList.toggle('dark', newTheme === 'dark')
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white dark:focus-visible:ring-offset-slate-950"
      aria-label={theme === 'light' ? 'التبديل للوضع الليلي' : 'التبديل للوضع النهاري'}
      title={theme === 'light' ? 'التبديل للوضع الليلي' : 'التبديل للوضع النهاري'}
    >
      {theme === 'light' ? <Moon className="h-[18px] w-[18px]" aria-hidden="true" /> : <Sun className="h-[18px] w-[18px]" aria-hidden="true" />}
    </button>
  )
}
