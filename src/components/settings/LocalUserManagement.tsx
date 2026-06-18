'use client';

import React, { useEffect, useState } from 'react';
import { getLocalUsersClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';

export default function LocalUserManagement() {
  const router = useRouter();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      const result = await getLocalUsersClient();
      if (result.success) {
        setUsers(result.data || []);
      } else {
        toast.error(result.error || 'فشل تحميل المستخدمين');
      }
      setLoading(false);
    };
    fetchUsers();
  }, []);

  return (
    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h4 className="text-xl font-bold text-slate-900 dark:text-white">إدارة المستخدمين المحليين</h4>
          <p className="text-slate-500 text-xs mt-1">حسابات الصيادلة النشطة في "The Enforcer"</p>
        </div>
        <button 
          onClick={() => router.push('/staff/manage?add=true')}
          className="bg-slate-900 dark:bg-white dark:text-slate-900 text-white px-6 py-2 rounded-xl text-xs font-black hover:opacity-90 transition-all"
        >
          إضافة مستخدم
        </button>
      </div>

      <div className="space-y-4">
        {loading ? (
          <p className="text-center py-4 text-slate-400">جاري التحميل...</p>
        ) : users.length === 0 ? (
          <p className="text-center py-4 text-slate-400">لا يوجد مستخدمين محليين. قم بالمزامنة مع السحابة أولاً.</p>
        ) : (
          users.map((user) => (
            <div key={user.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 ${user.role === 'owner' ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-slate-700'} text-white rounded-full flex items-center justify-center font-bold`}>
                  {user.full_name?.charAt(0) || 'U'}
                </div>
                <div>
                  <p className="font-bold text-sm text-slate-900 dark:text-white">{user.full_name}</p>
                  <p className="text-[10px] text-slate-400">{user.username}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {!user.has_password && (
                  <span className="text-[9px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-md font-bold">بدون كلمة مرور</span>
                )}
                <span className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase ${
                  user.role === 'owner' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                }`}>
                  {user.role === 'owner' ? 'مالك' : 'صيدلي'}
                </span>
                <button 
                  onClick={() => router.push(`/staff/manage?edit=${user.id}`)}
                  className="text-slate-400 hover:text-indigo-600 transition-colors"
                  title="تعديل الموظف وصلاحياته"
                >
                  ⚙️
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      
      <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800">
         <p className="text-[10px] text-slate-400 font-bold leading-relaxed">
           * يتم تشفير كلمات المرور وحفظها محلياً. في حالة نسيان كلمة مرور الصيدلي، يمكن للمالك إعادة تعيينها محلياً.
         </p>
      </div>
    </div>
  );
}
