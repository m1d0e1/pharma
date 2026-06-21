
'use client';

import React, { useState, useEffect } from 'react';
import { Save, Layout, Maximize2, Type, Barcode, Trash2, CheckCircle2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getLabelTemplatesAction, saveLabelTemplateAction } from '@/app/actions-client/labels';

export default function LabelDesigner() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<any>({
    name: 'Standard Barcode',
    width: 38, // mm
    height: 25, // mm
    content_json: JSON.stringify([
      { type: 'text', content: 'Trade Name', x: 2, y: 5, fontSize: 10, fontWeight: 'bold' },
      { type: 'barcode', content: 'BARCODE', x: 2, y: 12, width: 34, height: 8 },
      { type: 'text', content: 'Price: 0.00 EGP', x: 2, y: 22, fontSize: 8 }
    ]),
    is_default: true
  });

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    const res = await getLabelTemplatesAction();
    if (res.success) setTemplates(res.data || []);
  };

  const handleSave = async () => {
    const res = await saveLabelTemplateAction(activeTemplate);
    if (res.success) {
      toast.success('تم حفظ القالب بنجاح');
      fetchTemplates();
    } else {
      toast.error('فشل حفظ القالب');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 p-8" dir="rtl">
      {/* Sidebar: Template List */}
      <div className="lg:col-span-3 space-y-4">
        <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-2">
          <Layout className="w-6 h-6 text-primary-500" /> قوالب الملصقات
        </h3>
        <div className="space-y-2">
          {templates.map(t => (
            <button 
              key={t.id}
              onClick={() => setActiveTemplate(t)}
              className={`w-full p-4 rounded-2xl border flex items-center justify-between transition-all ${t.id === activeTemplate.id ? 'bg-primary-50 border-primary-500 text-primary-700' : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-800 text-slate-600'}`}
            >
              <span className="font-bold">{t.name}</span>
              {t.is_default === 1 && <CheckCircle2 className="w-4 h-4" />}
            </button>
          ))}
          <button className="w-full p-4 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl text-slate-400 font-bold hover:bg-slate-50 transition-all">
            + إضافة قالب جديد
          </button>
        </div>
      </div>

      {/* Main Designer */}
      <div className="lg:col-span-6 bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 space-y-8">
        <div className="flex justify-between items-center">
           <h2 className="text-2xl font-black text-slate-900 dark:text-white">مصمم الملصقات الذكي</h2>
           <button 
             onClick={handleSave}
             className="px-8 py-3 bg-primary-600 text-white rounded-2xl font-black shadow-lg hover:bg-primary-700 transition-all flex items-center gap-2"
           >
             <Save className="w-5 h-5" /> حفظ القالب
           </button>
        </div>

        {/* Canvas Preview */}
        <div className="flex justify-center bg-slate-50 dark:bg-slate-950 p-10 rounded-[32px] border-2 border-dashed border-slate-200 dark:border-slate-800 min-h-[300px] items-center">
           <div 
             className="bg-white text-black shadow-2xl relative overflow-hidden flex flex-col p-2"
             style={{ 
               width: `${activeTemplate.width * 4}px`, 
               height: `${activeTemplate.height * 4}px`,
               border: '1px solid #ddd'
             }}
           >
              {JSON.parse(activeTemplate.content_json).map((el: any, idx: number) => (
                <div key={idx} style={{ 
                  position: 'absolute', 
                  left: `${el.x * 4}px`, 
                  top: `${el.y * 4}px`,
                  fontSize: `${el.fontSize}px`,
                  fontWeight: el.fontWeight || 'normal'
                }}>
                  {el.type === 'text' ? el.content : (
                    <div className="bg-slate-100 w-full h-full flex flex-col items-center justify-center border border-slate-300">
                       <Barcode className="w-full h-1/2 opacity-50" />
                       <span className="text-[6px]">{el.content}</span>
                    </div>
                  )}
                </div>
              ))}
           </div>
        </div>

        {/* Property Editor */}
        <div className="grid grid-cols-2 gap-4">
           <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase">اسم القالب</label>
              <input 
                type="text" 
                value={activeTemplate.name}
                onChange={(e) => setActiveTemplate({...activeTemplate, name: e.target.value})}
                className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-2 border-transparent focus:border-primary-500 outline-none font-bold"
              />
           </div>
           <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase">الأبعاد (عرض × طول بالـ مم)</label>
              <div className="flex gap-2">
                 <input 
                   type="number" 
                   value={activeTemplate.width}
                   onChange={(e) => setActiveTemplate({...activeTemplate, width: parseInt(e.target.value)})}
                   className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-2 border-transparent focus:border-primary-500 outline-none font-bold"
                 />
                 <input 
                   type="number" 
                   value={activeTemplate.height}
                   onChange={(e) => setActiveTemplate({...activeTemplate, height: parseInt(e.target.value)})}
                   className="w-full p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border-2 border-transparent focus:border-primary-500 outline-none font-bold"
                 />
              </div>
           </div>
        </div>
      </div>

      {/* Tool Palette */}
      <div className="lg:col-span-3 space-y-6">
         <h3 className="text-xl font-black text-slate-800 dark:text-white">الأدوات</h3>
         <div className="grid grid-cols-1 gap-3">
            <button className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl font-bold hover:border-primary-500 transition-all">
               <Type className="w-5 h-5 text-primary-500" /> إضافة نص
            </button>
            <button className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl font-bold hover:border-primary-500 transition-all">
               <Barcode className="w-5 h-5 text-primary-500" /> إضافة باركود
            </button>
            <button className="flex items-center gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl font-bold hover:border-primary-500 transition-all">
               <Maximize2 className="w-5 h-5 text-primary-500" /> إضافة إطار
            </button>
            <hr className="border-slate-100 dark:border-slate-800 my-4" />
            <button className="flex items-center gap-3 p-4 bg-rose-50 text-rose-600 rounded-2xl font-bold hover:bg-rose-600 hover:text-white transition-all">
               <Trash2 className="w-5 h-5" /> حذف القالب
            </button>
         </div>
      </div>
    </div>
  );
}
