import React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  success?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
  variant?: 'default' | 'filled' | 'outline' | 'ghost';
  inputSize?: 'sm' | 'md' | 'lg';
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({
    className,
    label,
    error,
    success,
    helperText,
    leftIcon,
    rightIcon,
    fullWidth = true,
    variant = 'default',
    inputSize = 'md',
    id,
    disabled,
    ...props
  }, ref) => {
    const inputId = id || `input-${Math.random().toString(36).substr(2, 9)}`;
    
    const variantClasses = {
      default: 'input-primary',
      filled: 'bg-slate-100 dark:bg-slate-800 border-transparent focus:bg-white dark:focus:bg-slate-800 focus:border-primary-300 dark:focus:border-primary-700',
      outline: 'bg-transparent border-2 border-slate-300 dark:border-slate-600 focus:border-primary-500 dark:focus:border-primary-500',
      ghost: 'bg-transparent border-transparent focus:bg-slate-50 dark:focus:bg-slate-800/50'
    };
    
    const sizeClasses = {
      sm: 'h-9 px-3 py-2 text-sm',
      md: 'h-12 px-4 py-3',
      lg: 'h-14 px-5 py-4 text-lg'
    };
    
    return (
      <div className={cn('space-y-2', fullWidth && 'w-full')}>
        {label && (
          <label 
            htmlFor={inputId} 
            className="block text-sm font-semibold text-slate-700 dark:text-slate-300"
          >
            {label}
            {props.required && <span className="text-danger-500 mr-1">*</span>}
          </label>
        )}
        
        <div className="relative">
          {leftIcon && (
            <div className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 dark:text-slate-500 z-10">
              {leftIcon}
            </div>
          )}
          
          <input
            id={inputId}
            className={cn(
              'w-full rounded-xl border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-300 dark:focus:border-primary-700 placeholder:text-slate-400 dark:placeholder:text-slate-500 disabled:opacity-50 disabled:cursor-not-allowed',
              variantClasses[variant],
              sizeClasses[inputSize],
              leftIcon && 'pr-10',
              rightIcon && 'pl-10',
              error && 'input-error border-danger-300 dark:border-danger-700 focus:ring-danger-500/30',
              success && 'input-success border-success-300 dark:border-success-700 focus:ring-success-500/30',
              disabled && 'input-disabled',
              className
            )}
            ref={ref}
            disabled={disabled}
            {...props}
          />
          
          {rightIcon && (
            <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 dark:text-slate-500 z-10">
              {rightIcon}
            </div>
          )}
          
          {success && !error && (
            <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-success-500">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
              </svg>
            </div>
          )}
        </div>
        
        {(error || success || helperText) && (
          <p className={cn(
            'text-sm flex items-center gap-1.5',
            error && 'text-danger-600 dark:text-danger-400',
            success && 'text-success-600 dark:text-success-400',
            !error && !success && 'text-slate-500 dark:text-slate-400'
          )}>
            {error && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            )}
            {success && !error && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            )}
            {error || success || helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };