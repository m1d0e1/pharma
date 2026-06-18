'use client'

import React, { useEffect } from 'react'
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
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
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
    <div className="fixed inset-0 z-[100] animate-in fade-in duration-300">
      {/* Backdrop */}
      <div 
        className={cn(
          "fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity",
          overlayClassName
        )}
        onClick={onClose}
      />
      
      {/* Modal Container */}
      <div className="fixed inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          {/* Modal Content */}
          <div 
            className={cn(
              "relative w-full transform overflow-hidden rounded-2xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in zoom-in slide-in-from-bottom-8 duration-500",
              sizeClasses[size],
              contentClassName
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            {(title || description || showCloseButton) && (
              <div className="border-b border-slate-100 dark:border-slate-800 px-8 py-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    {title && (
                      <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
                        {title}
                      </h2>
                    )}
                    {description && (
                      <p className="mt-2 text-slate-600 dark:text-slate-400">
                        {description}
                      </p>
                    )}
                  </div>
                  
                  {showCloseButton && (
                    <button
                      onClick={onClose}
                      className="ml-4 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                      aria-label="Close"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Body */}
            <div className="px-8 py-6">
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
  <div className={cn("px-8 py-6 border-b border-slate-100 dark:border-slate-800", className)}>
    {children}
  </div>
)

interface ModalBodyProps {
  children: React.ReactNode
  className?: string
}

const ModalBody: React.FC<ModalBodyProps> = ({ children, className }) => (
  <div className={cn("px-8 py-6", className)}>
    {children}
  </div>
)

interface ModalFooterProps {
  children: React.ReactNode
  className?: string
}

const ModalFooter: React.FC<ModalFooterProps> = ({ children, className }) => (
  <div className={cn("px-8 py-6 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30", className)}>
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
  <h2 className={cn("text-2xl font-bold text-slate-900 dark:text-white", className)}>
    {children}
  </h2>
)

interface ModalDescriptionProps {
  children: React.ReactNode
  className?: string
}

const ModalDescription: React.FC<ModalDescriptionProps> = ({ children, className }) => (
  <p className={cn("mt-2 text-slate-600 dark:text-slate-400", className)}>
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