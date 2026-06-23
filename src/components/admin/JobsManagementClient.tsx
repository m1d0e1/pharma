'use client'

import React, { useState } from 'react'
import { Plus, Trash2, Briefcase, DollarSign, Languages } from 'lucide-react'
import toast from 'react-hot-toast'
import { 
  Card, 
  CardContent, 
  CardDescription, 
  CardHeader, 
  CardTitle 
} from '@/components/ui/card'

interface Job {
  id: number
  name_ar: string
  name_en: string | null
  min_salary: number
  max_salary: number
}

interface Props {
  initialJobs: Job[]
  onAddJob: (data: any) => Promise<{ success: boolean; error?: string }>
  onDeleteJob: (id: number) => Promise<{ success: boolean; error?: string }>
}

export default function JobsManagementClient({ initialJobs, onAddJob, onDeleteJob }: Props) {
  const [jobs, setJobs] = useState<Job[]>(initialJobs)
  const [isAdding, setIsAdding] = useState(false)
  const [newJob, setNewJob] = useState({
    name_ar: '',
    name_en: '',
    min_salary: 0,
    max_salary: 0
  })

  React.useEffect(() => {
    setJobs(initialJobs)
  }, [initialJobs])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newJob.name_ar) return toast.error('يرجى إدخال المسمى الوظيفي بالعربي')

    const res = await onAddJob(newJob)
    if (res.success) {
      toast.success('تم إضافة الوظيفة بنجاح')
      setNewJob({ name_ar: '', name_en: '', min_salary: 0, max_salary: 0 })
    } else {
      toast.error(res.error || 'فشل إضافة الوظيفة')
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('هل أنت متأكد من حذف هذه الوظيفة؟')) return
    const res = await onDeleteJob(id)
    if (res.success) {
      toast.success('تم حذف الوظيفة')
      // Note: jobs will be updated automatically by useEffect when initialJobs updates
    } else {
      toast.error(res.error || 'فشل حذف الوظيفة')
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      {/* List of Jobs */}
      <div className="lg:col-span-2 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {jobs.map((job) => (
            <Card key={job.id} className="overflow-hidden border-none shadow-premium hover:shadow-premium-hover transition-all group">
              <CardHeader className="bg-slate-50 dark:bg-slate-800/50 pb-4">
                <div className="flex justify-between items-start">
                  <div className="p-3 bg-white dark:bg-slate-700 rounded-2xl shadow-sm">
                    <Briefcase className="w-6 h-6 text-primary-600" />
                  </div>
                  <button 
                    onClick={() => handleDelete(job.id)}
                    className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
                <CardTitle className="mt-4 text-xl font-bold">{job.name_ar}</CardTitle>
                <CardDescription className="font-medium text-slate-500">{job.name_en || 'No English Name'}</CardDescription>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between text-sm">
                  <div className="space-y-1">
                    <p className="text-slate-400 font-bold">الحد الأدنى</p>
                    <p className="text-lg font-black text-slate-900 dark:text-white">
                      {(job.min_salary ?? 0).toLocaleString()} <span className="text-xs text-slate-400 font-medium">ج.م</span>
                    </p>
                  </div>
                  <div className="w-px h-10 bg-slate-100 dark:bg-slate-700 mx-4" />
                  <div className="space-y-1 text-left">
                    <p className="text-slate-400 font-bold">الحد الأقصى</p>
                    <p className="text-lg font-black text-primary-600">
                      {(job.max_salary ?? 0).toLocaleString()} <span className="text-xs text-slate-400 font-medium">ج.م</span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          
          {jobs.length === 0 && (
            <div className="col-span-full py-20 text-center space-y-4 bg-slate-50 dark:bg-slate-800/30 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
              <div className="w-20 h-20 bg-white dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto shadow-sm">
                <Briefcase className="w-10 h-10 text-slate-300" />
              </div>
              <p className="text-slate-400 font-bold text-lg">لا توجد وظائف مسجلة حالياً</p>
            </div>
          )}
        </div>
      </div>

      {/* Add Form */}
      <div className="space-y-6">
        <Card className="border-none shadow-premium sticky top-24">
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              <div className="p-2 bg-primary-100 dark:bg-primary-900/30 rounded-lg">
                <Plus className="w-5 h-5 text-primary-600" />
              </div>
              إضافة وظيفة جديدة
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                  <Languages className="w-4 h-4" /> المسمى (بالعربي)
                </label>
                <input 
                  type="text"
                  required
                  value={newJob.name_ar}
                  onChange={e => setNewJob({...newJob, name_ar: e.target.value})}
                  className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-primary-500 transition-all font-bold"
                  placeholder="مثال: صيدلي، محاسب..."
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                  <Languages className="w-4 h-4" /> المسمى (بالإنجليزي)
                </label>
                <input 
                  type="text"
                  value={newJob.name_en}
                  onChange={e => setNewJob({...newJob, name_en: e.target.value})}
                  className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-primary-500 transition-all font-bold"
                  placeholder="Example: Pharmacist"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                    <DollarSign className="w-4 h-4" /> أقل مرتب
                  </label>
                  <input 
                    type="number"
                    value={newJob.min_salary}
                    onChange={e => setNewJob({...newJob, min_salary: Number(e.target.value)})}
                    className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-primary-500 transition-all font-bold"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                    <DollarSign className="w-4 h-4" /> أعلى مرتب
                  </label>
                  <input 
                    type="number"
                    value={newJob.max_salary}
                    onChange={e => setNewJob({...newJob, max_salary: Number(e.target.value)})}
                    className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-primary-500 transition-all font-bold"
                  />
                </div>
              </div>

              <button 
                type="submit"
                className="w-full py-4 bg-gradient-primary text-white rounded-2xl font-black shadow-lg shadow-primary-500/30 hover:shadow-primary-500/50 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <Plus className="w-6 h-6" />
                حفظ الوظيفة
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
