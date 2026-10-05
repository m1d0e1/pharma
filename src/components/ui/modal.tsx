'use client'

import React, { useEffect, useId, useRef } from 'react'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  description?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  showCloseButton?: boolean
  overlayClassName?: string
  contentClassName?: string
}

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  size = 'md',
  showCloseButton = true,
  overlayClassName,
  contentClassName,
}) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!isOpen) return
    const previousActiveElement = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element)
      return !element.hidden
        && element.getAttribute('aria-hidden') !== 'true'
        && style.display !== 'none'
        && style.visibility !== 'hidden'
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const content = contentRef.current
      if (!content) return
      const focusable = Array.from(content.querySelectorAll<HTMLElement>(focusableSelector))
        .filter(isVisible)
      if (focusable.length === 0) {
        e.preventDefault()
        content.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === content)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleEscape)
    document.addEventListener('keydown', handleTab)
    document.body.style.overflow = 'hidden'

    const frame = window.requestAnimationFrame(() => {
      const content = contentRef.current
      if (!content) return
      const firstFocusable = Array.from(content.querySelectorAll<HTMLElement>(focusableSelector)).find(isVisible)
      ;(firstFocusable || content).focus()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('keydown', handleTab)
      document.body.style.overflow = previousOverflow
      previousActiveElement?.focus?.()
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full mx-4'
  }

  return (
    <div className="fixed inset-0 z-[100]">
      {/* Backdrop */}
      <div 
        className={cn(
          "fixed inset-0 bg-slate-950/55 transition-opacity",
          overlayClassName
        )}
        onClick={onClose}
      />
      
      {/* Modal Container */}
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-3 sm:p-5">
          {/* Modal Content */}
          <div 
            ref={contentRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            aria-label={!title ? 'نافذة حوار' : undefined}
            tabIndex={-1}
            className={cn(
              "relative w-full transform overflow-hidden rounded-xl bg-white dark:bg-slate-900 shadow-xl border border-slate-200 dark:border-slate-800",
              sizeClasses[size],
              contentClassName
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {(title || description || showCloseButton) && (
              <div className="border-b border-slate-200 dark:border-slate-800 px-5 sm:px-6 py-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {title && (
                      <h2 id={titleId} className="text-xl font-semibold text-slate-900 dark:text-white">
                        {title}
                      </h2>
                    )}
                    {description && (
                      <p id={descriptionId} className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
                        {description}
                      </p>
                    )}
                  </div>
                  
                  {showCloseButton && (
                    <button
                      type="button"
                      onClick={onClose}
                      className="ms-4 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
                      aria-label="إغلاق النافذة"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Body */}
            <div className="px-5 sm:px-6 py-5">
              {children}
            </div>

            {/* Optional Footer */}
            {/* Footer can be added via children if needed */}
          </div>
        </div>
      </div>
    </div>
  )
}

interface ModalHeaderProps {
  children: React.ReactNode
  className?: string
}

const ModalHeader: React.FC<ModalHeaderProps> = ({ children, className }) => (
  <div className={cn("px-5 sm:px-6 py-4 border-b border-slate-200 dark:border-slate-800", className)}>
    {children}
  </div>
)

interface ModalBodyProps {
  children: React.ReactNode
  className?: string
}

const ModalBody: React.FC<ModalBodyProps> = ({ children, className }) => (
  <div className={cn("px-5 sm:px-6 py-5", className)}>
    {children}
  </div>
)

interface ModalFooterProps {
  children: React.ReactNode
  className?: string
}

const ModalFooter: React.FC<ModalFooterProps> = ({ children, className }) => (
  <div className={cn("px-5 sm:px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40", className)}>
    <div className="flex items-center justify-end gap-3">
      {children}
    </div>
  </div>
)

interface ModalTitleProps {
  children: React.ReactNode
  className?: string
}

const ModalTitle: React.FC<ModalTitleProps> = ({ children, className }) => (
  <h2 className={cn("text-xl font-semibold text-slate-900 dark:text-white", className)}>
    {children}
  </h2>
)

interface ModalDescriptionProps {
  children: React.ReactNode
  className?: string
}

const ModalDescription: React.FC<ModalDescriptionProps> = ({ children, className }) => (
  <p className={cn("mt-1.5 text-sm text-slate-600 dark:text-slate-400", className)}>
    {children}
  </p>
)

export {
  Modal,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalTitle,
  ModalDescription,
}
