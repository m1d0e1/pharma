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
    const baseStyles = 'inline-flex items-center justify-center whitespace-nowrap rounded-2xl font-bold tracking-wide ring-offset-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-95 duration-300 hover-lift hover-glow';
    
    const variants = {
      default: 'bg-gradient-primary text-white hover:shadow-xl hover:shadow-primary-500/40 hover:-translate-y-0.5',
      destructive: 'bg-gradient-danger text-white hover:shadow-xl hover:shadow-danger-500/40 hover:-translate-y-0.5',
      success: 'bg-gradient-success text-white hover:shadow-xl hover:shadow-success-500/40 hover:-translate-y-0.5',
      outline: 'border-2 border-slate-300 bg-transparent text-slate-700 hover:bg-gradient-to-r hover:from-slate-50 hover:to-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:from-slate-800 dark:hover:to-slate-900 hover:border-slate-400 dark:hover:border-slate-500',
      secondary: 'bg-gradient-to-r from-slate-100 to-slate-200 text-slate-800 hover:from-slate-200 hover:to-slate-300 dark:from-slate-800 dark:to-slate-900 dark:text-slate-300 dark:hover:from-slate-700 dark:hover:to-slate-800',
      ghost: 'hover:bg-gradient-to-r hover:from-slate-50 hover:to-slate-100 hover:text-slate-800 dark:hover:from-slate-800 dark:hover:to-slate-900 dark:hover:text-slate-300',
      link: 'text-primary-600 underline-offset-4 hover:underline dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300',
      gradient: 'bg-gradient-to-r from-primary-600 via-primary-500 to-primary-400 text-white hover:from-primary-700 hover:via-primary-600 hover:to-primary-500 hover:shadow-xl hover:shadow-primary-500/40 hover:-translate-y-0.5',
    };

    const sizes = {
      sm: 'h-10 px-5 text-xs rounded-xl',
      default: 'h-13 px-7 py-3.5',
      lg: 'h-15 px-9 text-base rounded-2xl',
      xl: 'h-17 px-11 text-lg rounded-2xl',
      icon: 'h-11 w-11 rounded-xl',
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
            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-current" role="status" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
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
