import React from 'react'
import { cn } from '@/lib/utils'

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded'
  width?: string | number
  height?: string | number
  animation?: 'pulse' | 'wave' | 'none'
}

const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ 
    className, 
    variant = 'rounded',
    width,
    height,
    animation = 'pulse',
    style,
    ...props 
  }, ref) => {
    const variantClasses = {
      text: 'h-4 rounded',
      circular: 'rounded-full',
      rectangular: 'rounded-none',
      rounded: 'rounded-xl'
    }

    const animationClasses = {
      pulse: 'animate-pulse',
      wave: 'shimmer',
      none: ''
    }

    return (
      <div
        ref={ref}
        className={cn(
          'bg-slate-200 dark:bg-slate-700',
          variantClasses[variant],
          animationClasses[animation],
          className
        )}
        style={{
          width: width ? (typeof width === 'number' ? `${width}px` : width) : undefined,
          height: height ? (typeof height === 'number' ? `${height}px` : height) : undefined,
          ...style
        }}
        {...props}
      />
    )
  }
)
Skeleton.displayName = 'Skeleton'

interface SkeletonGroupProps {
  children: React.ReactNode
  className?: string
  spacing?: 'none' | 'sm' | 'md' | 'lg'
}

const SkeletonGroup: React.FC<SkeletonGroupProps> = ({ 
  children, 
  className,
  spacing = 'md' 
}) => {
  const spacingClasses = {
    none: 'gap-0',
    sm: 'gap-2',
    md: 'gap-4',
    lg: 'gap-6'
  }

  return (
    <div className={cn('flex flex-col', spacingClasses[spacing], className)}>
      {children}
    </div>
  )
}

// Predefined skeleton components for common patterns
const CardSkeleton = () => (
  <div className="card p-6 space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton variant="text" width="40%" height={20} />
      <Skeleton variant="circular" width={40} height={40} />
    </div>
    <Skeleton variant="text" width="60%" height={24} />
    <Skeleton variant="text" width="80%" height={16} />
    <div className="flex items-center gap-2 pt-2">
      <Skeleton variant="rounded" width={80} height={32} />
      <Skeleton variant="rounded" width={80} height={32} />
    </div>
  </div>
)

const TableSkeleton = ({ rows = 5, columns = 4 }) => (
  <div className="table-container">
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex gap-4">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`header-${i}`} variant="text" width={`${Math.random() * 30 + 20}%`} height={20} />
        ))}
      </div>
      
      {/* Rows */}
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={`row-${rowIndex}`} className="flex gap-4 py-3">
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton 
                key={`cell-${rowIndex}-${colIndex}`} 
                variant="text" 
                width={`${Math.random() * 40 + 20}%`} 
                height={16} 
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  </div>
)

const StatCardSkeleton = () => (
  <div className="stat-card p-6">
    <div className="flex items-center justify-between mb-4">
      <Skeleton variant="text" width="40%" height={16} />
      <Skeleton variant="circular" width={40} height={40} />
    </div>
    <Skeleton variant="text" width="60%" height={32} className="mb-2" />
    <div className="flex items-center gap-2">
      <Skeleton variant="rounded" width={60} height={20} />
      <Skeleton variant="text" width="30%" height={14} />
    </div>
  </div>
)

export {
  Skeleton,
  SkeletonGroup,
  CardSkeleton,
  TableSkeleton,
  StatCardSkeleton
}