import React from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'success' | 'outline' | 'secondary' | 'ghost' | 'link' | 'gradient';
  size?: 'default' | 'sm' | 'lg' | 'xl' | 'icon';
  loading?: boolean;
  fullWidth?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', loading = false, fullWidth = false, children, disabled, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold ring-offset-white dark:ring-offset-slate-950 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';
    
    const variants = {
      default: 'bg-primary-700 text-white hover:bg-primary-800 dark:bg-primary-700 dark:hover:bg-primary-800',
      destructive: 'bg-danger-600 text-white hover:bg-danger-700 dark:bg-danger-600 dark:hover:bg-danger-700',
      success: 'bg-success-700 text-white hover:bg-success-800 dark:bg-success-700 dark:hover:bg-success-800',
      outline: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:border-slate-600',
      secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
      ghost: 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white',
      link: 'text-primary-600 underline-offset-4 hover:underline dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300',
      gradient: 'bg-primary-700 text-white hover:bg-primary-800 dark:bg-primary-700 dark:hover:bg-primary-800',
    };

    const sizes = {
      sm: 'h-9 px-3.5 text-sm',
      default: 'h-10 px-4 text-sm',
      lg: 'h-11 px-5 text-base',
      xl: 'h-12 px-6 text-base',
      icon: 'h-10 w-10',
    };

    return (
      <button
        className={cn(
          baseStyles,
          variants[variant],
          sizes[size],
          fullWidth && 'w-full',
          loading && 'opacity-70 cursor-wait',
          className
        )}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <svg className="animate-spin h-4 w-4 text-current" role="status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {children}
          </>
        ) : children}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { Button };
