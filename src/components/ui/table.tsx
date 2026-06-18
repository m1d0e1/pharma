import React from 'react';
import { cn } from '@/lib/utils';

interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  striped?: boolean;
  hover?: boolean;
  compact?: boolean;
  bordered?: boolean;
  variant?: 'default' | 'minimal' | 'elevated';
}

interface TableHeaderProps extends React.HTMLAttributes<HTMLTableSectionElement> {}

interface TableBodyProps extends React.HTMLAttributes<HTMLTableSectionElement> {}

interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  hover?: boolean;
  active?: boolean;
}

interface TableHeadProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  sortable?: boolean;
  sortDirection?: 'asc' | 'desc' | 'none';
}

interface TableCellProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
  highlight?: boolean;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, striped = true, hover = true, compact = false, bordered = true, variant = 'default', ...props }, ref) => {
    const tableClasses = cn(
      'w-full text-sm text-left',
      compact && 'table-compact',
      variant === 'minimal' && 'border-separate border-spacing-0',
      variant === 'elevated' && 'shadow-sm',
      className
    );

    const containerClasses = cn(
      'overflow-x-auto rounded-xl',
      bordered && 'border border-slate-200/50 dark:border-slate-700/50',
      variant === 'elevated' && 'shadow-soft',
      variant === 'default' && 'table-container'
    );

    return (
      <div className={containerClasses}>
        <table
          ref={ref}
          className={tableClasses}
          {...props}
        />
      </div>
    );
  }
);
Table.displayName = 'Table';

const TableHeader = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, ...props }, ref) => (
    <thead 
      ref={ref} 
      className={cn(
        'bg-slate-50/80 dark:bg-slate-800/80 backdrop-blur-sm border-b border-slate-200/50 dark:border-slate-700/50',
        className
      )} 
      {...props} 
    />
  )
);
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef<HTMLTableSectionElement, TableBodyProps>(
  ({ className, ...props }, ref) => (
    <tbody 
      ref={ref} 
      className={cn('divide-y divide-slate-200/30 dark:divide-slate-700/30', className)} 
      {...props} 
    />
  )
);
TableBody.displayName = 'TableBody';

const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, hover = true, active = false, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'transition-colors duration-200',
        hover && 'hover:bg-slate-50/50 dark:hover:bg-slate-800/30',
        active && 'bg-primary-50/30 dark:bg-primary-900/20',
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ className, sortable, sortDirection = 'none', children, ...props }, ref) => {
    const SortIcon = () => {
      if (sortDirection === 'asc') {
        return (
          <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        );
      }
      if (sortDirection === 'desc') {
        return (
          <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        );
      }
      if (sortable) {
        return (
          <svg className="w-3 h-3 ml-1 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        );
      }
      return null;
    };

    return (
      <th
        ref={ref}
        className={cn(
          'px-6 py-4 font-semibold text-slate-700 dark:text-slate-300 text-right first:rounded-tr-lg last:rounded-tl-lg',
          sortable && 'cursor-pointer hover:bg-slate-100/50 dark:hover:bg-slate-800/50',
          sortDirection !== 'none' && 'bg-primary-50/30 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300',
          className
        )}
        {...props}
      >
        <div className="flex items-center justify-end gap-1">
          {children}
          <SortIcon />
        </div>
      </th>
    );
  }
);
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ className, align = 'right', highlight = false, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        'px-6 py-4 border-b border-slate-100/50 dark:border-slate-800/50',
        align === 'left' && 'text-left',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        highlight && 'font-medium text-primary-700 dark:text-primary-300',
        className
      )}
      {...props}
    />
  )
);
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption
      ref={ref}
      className={cn('mt-4 text-sm text-slate-500 dark:text-slate-400 px-6', className)}
      {...props}
    />
  )
);
TableCaption.displayName = 'TableCaption';

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn(
        'bg-slate-50/50 dark:bg-slate-800/30 border-t border-slate-200/50 dark:border-slate-700/50',
        className
      )}
      {...props}
    />
  )
);
TableFooter.displayName = 'TableFooter';

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  TableFooter,
};