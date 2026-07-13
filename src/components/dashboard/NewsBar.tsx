'use client';

import { useEffect, useState } from 'react';
import { X, Megaphone, Pill, Zap, Globe } from 'lucide-react';

// ─── How to add news ─────────────────────────────────────────────────────────
// 1. Go to Supabase → Storage → app-news bucket (create if missing, set to PUBLIC)
// 2. Upload / replace the file "news.json" with content like:
//    [
//      { "id": "2026-07-11-1", "text": "تم إضافة 500 دواء جديد لقاعدة البيانات", "type": "drugs" },
//      { "id": "2026-07-11-2", "text": "تم تحديث 1200 تفاعل دوائي", "type": "interactions" }
//    ]
// 3. The bar will show the latest item automatically on next app load.
// ─────────────────────────────────────────────────────────────────────────────

const NEWS_URL = 'https://ntaaxbjeoqyetrmxyktf.supabase.co/storage/v1/object/public/app-news/news.json';
const DISMISS_KEY = 'news_dismissed_id';

const TYPE_ICON: Record<string, any> = {
  drugs: Pill,
  interactions: Zap,
  general: Megaphone,
};

interface NewsItem {
  id: string;
  text: string;
  type?: 'drugs' | 'interactions' | 'general';
}

export default function NewsBar() {
  const [item, setItem] = useState<NewsItem | null>(null);
  const [visible, setVisible] = useState(false);

  const checkVisibility = (latestItem: NewsItem) => {
    const dismissed = localStorage.getItem(DISMISS_KEY);
    const enabled = localStorage.getItem('news_bar_enabled') !== 'false';
    
    if (dismissed !== latestItem.id && enabled) {
      setVisible(true);
    } else {
      setVisible(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const fallback = { id: 'default-welcome', text: 'أهلاً بك في نظام فارما! شريط الأخبار متصل ويعمل بنجاح. يمكنك تحديث قائمة الأدوية والتفاعلات من الأزرار أدناه.', type: 'general' as const };

    fetch(NEWS_URL, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then((items: NewsItem[] | null) => {
        if (cancelled) return;
        if (!items?.length) {
          setItem(fallback);
          checkVisibility(fallback);
          return;
        }
        const latest = items[0];
        setItem(latest);
        checkVisibility(latest);
      })
      .catch(() => {
        if (cancelled) return;
        setItem(fallback);
        checkVisibility(fallback);
      });

    const handleToggle = () => {
      checkVisibility(item || fallback);
    };

    window.addEventListener('news-bar-toggle', handleToggle);
    return () => {
      cancelled = true;
      window.removeEventListener('news-bar-toggle', handleToggle);
    };
  }, [item]);

  const dismiss = () => {
    if (item) {
      localStorage.setItem(DISMISS_KEY, item.id);
      localStorage.setItem('news_bar_enabled', 'false');
    }
    setVisible(false);
    window.dispatchEvent(new Event('news-bar-state-changed'));
  };

  if (!visible || !item) return null;

  const Icon = TYPE_ICON[item.type || 'general'] ?? Megaphone;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-gradient-to-l from-blue-600 to-indigo-700 text-white text-sm font-bold rounded-2xl shadow-lg w-full overflow-hidden animate-in slide-in-from-top-2 duration-300">
      <style>{`
        @keyframes marquee {
          0% { transform: translate3d(50%, 0, 0); }
          100% { transform: translate3d(-100%, 0, 0); }
        }
        .animate-marquee {
          animation: marquee 20s linear infinite;
        }
      `}</style>
      <Globe className="w-4 h-4 shrink-0 opacity-70" />
      <Icon className="w-4 h-4 shrink-0" />
      <div className="flex-1 overflow-hidden relative h-5 select-none" dir="ltr">
        <div className="absolute right-0 top-0 whitespace-nowrap animate-marquee hover:[animation-play-state:paused] cursor-pointer text-right w-full pr-4">
          {item.text}
        </div>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 p-1 rounded-full hover:bg-white/20 transition-colors"
        aria-label="إخفاء"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
