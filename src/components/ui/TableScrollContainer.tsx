'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  topScrollClassName?: string;
  showScrollButtons?: boolean;
}

export default function TableScrollContainer({
  children,
  className,
  containerClassName,
  topScrollClassName,
  showScrollButtons = true,
}: Props) {
  const topScrollRef = useRef<HTMLDivElement>(null);
  const bottomScrollRef = useRef<HTMLDivElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [clientWidth, setClientWidth] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const isSyncingTop = useRef(false);
  const isSyncingBottom = useRef(false);

  const updateDimensions = useCallback(() => {
    if (bottomScrollRef.current) {
      const el = bottomScrollRef.current;
      setScrollWidth(el.scrollWidth);
      setClientWidth(el.clientWidth);

      // In RTL, scrollLeft is 0 at the rightmost position and negative or positive depending on browser implementation
      const maxScroll = el.scrollWidth - el.clientWidth;
      const currentScroll = Math.abs(el.scrollLeft);
      setCanScrollLeft(currentScroll < maxScroll - 4);
      setCanScrollRight(currentScroll > 4);
    }
  }, []);

  useEffect(() => {
    updateDimensions();

    const bottomEl = bottomScrollRef.current;
    if (!bottomEl) return;

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });

    resizeObserver.observe(bottomEl);
    if (bottomEl.firstElementChild) {
      resizeObserver.observe(bottomEl.firstElementChild);
    }

    const handleWindowResize = () => updateDimensions();
    window.addEventListener('resize', handleWindowResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [updateDimensions, children]);

  // Synchronize Top -> Bottom
  const handleTopScroll = () => {
    if (isSyncingTop.current) {
      isSyncingTop.current = false;
      return;
    }
    if (topScrollRef.current && bottomScrollRef.current) {
      isSyncingBottom.current = true;
      bottomScrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
      updateDimensions();
    }
  };

  // Synchronize Bottom -> Top
  const handleBottomScroll = () => {
    if (isSyncingBottom.current) {
      isSyncingBottom.current = false;
      return;
    }
    if (topScrollRef.current && bottomScrollRef.current) {
      isSyncingTop.current = true;
      topScrollRef.current.scrollLeft = bottomScrollRef.current.scrollLeft;
      updateDimensions();
    }
  };

  // Quick button scroll
  const scrollStep = (direction: 'left' | 'right', jumpToEnd = false) => {
    if (bottomScrollRef.current) {
      const el = bottomScrollRef.current;
      if (jumpToEnd) {
        const target = direction === 'left' ? -el.scrollWidth : 0;
        el.scrollTo({ left: target, behavior: 'smooth' });
      } else {
        const delta = direction === 'left' ? -350 : 350;
        el.scrollBy({ left: delta, behavior: 'smooth' });
      }
    }
  };

  const hasOverflow = scrollWidth > clientWidth + 4;

  return (
    <div className={cn("relative w-full group/tablescroll", containerClassName)}>
      {/* Top Synchronized Horizontal Scrollbar & Quick Navigation */}
      {hasOverflow && (
        <div className="sticky top-0 z-20 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-700/80 py-1.5 px-2 rounded-t-2xl flex items-center gap-2 select-none shadow-sm no-print">
          {showScrollButtons && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => scrollStep('right', true)}
                disabled={!canScrollRight}
                aria-label="بداية الجدول (اليمين)"
                className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-25 transition-all text-xs flex items-center"
                title="بداية الجدول"
              >
                <ChevronsRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => scrollStep('right', false)}
                disabled={!canScrollRight}
                aria-label="تمرير لليمين"
                className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-25 transition-all text-xs flex items-center gap-1 font-bold"
                title="تمرير لليمين"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Synchronized Top Scroll Track */}
          <div
            ref={topScrollRef}
            onScroll={handleTopScroll}
            className={cn(
              "overflow-x-auto flex-1 h-3 scrollbar-thin scrollbar-thumb-blue-500/60 hover:scrollbar-thumb-blue-600 dark:scrollbar-thumb-blue-500/80 scrollbar-track-slate-100 dark:scrollbar-track-slate-800 rounded-full",
              topScrollClassName
            )}
            title="شريط التمرير الأفقي العلوي"
          >
            <div style={{ width: `${scrollWidth}px`, height: '1px' }} />
          </div>

          {showScrollButtons && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => scrollStep('left', false)}
                disabled={!canScrollLeft}
                aria-label="تمرير لليسار"
                className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-25 transition-all text-xs flex items-center gap-1 font-bold"
                title="تمرير لليسار"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => scrollStep('left', true)}
                disabled={!canScrollLeft}
                aria-label="نهاية الجدول (اليسار)"
                className="p-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-25 transition-all text-xs flex items-center"
                title="نهاية الجدول"
              >
                <ChevronsLeft className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Table Content Container */}
      <div
        ref={bottomScrollRef}
        onScroll={handleBottomScroll}
        className={cn("overflow-x-auto w-full", className)}
      >
        {children}
      </div>
    </div>
  );
}
