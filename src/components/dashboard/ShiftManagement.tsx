'use client';

import { useState, useEffect } from 'react';
import { Clock, Play, StopCircle, DollarSign, Loader2, ArrowRightLeft, TrendingUp } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { startShiftAction, getCurrentShiftAction, getCurrentShiftStatsAction, endShiftAction } from '@/app/actions/shifts';

export default function ShiftManagement() {
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showStartModal, setShowStartModal] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [startingCash, setStartingCash] = useState('');
  const [endingCash, setEndingCash] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [shiftStats, setShiftStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    fetchShift();
  }, []);

  const fetchShift = async () => {
    setLoading(true);
    const result = await getCurrentShiftAction();
    if (result.success) {
      setCurrentShift(result.data);
      if (result.data?.id) {
        localStorage.setItem('currentShiftId', result.data.id);
        fetchStats();
      } else {
        localStorage.removeItem('currentShiftId');
        setShiftStats(null);
      }
    }
    setLoading(false);
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    const result = await getCurrentShiftStatsAction();
    if (result.success) {
      setShiftStats(result.data);
    }
    setStatsLoading(false);
  };

  const handleStartShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsStarting(true);
    
    const cash = parseFloat(startingCash) || 0;
    const result = await startShiftAction(cash);
    
    if (result.success) {
      toast.success('Shift started successfully');
      if (result.shiftId) {
        localStorage.setItem('currentShiftId', result.shiftId);
      }
      setShowStartModal(false);
      fetchShift();
    } else {
      toast.error(result.error || 'Failed to start shift');
    }
    setIsStarting(false);
  };

  const handleEndShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsEnding(true);
    
    const cash = parseFloat(endingCash) || 0;
    const result = await endShiftAction(cash);
    
    if (result.success) {
      toast.success('Shift closed successfully');
      localStorage.removeItem('currentShiftId');
      setShowEndModal(false);
      setCurrentShift(null);
      setShiftStats(null);
      fetchShift();
    } else {
      toast.error(result.error || 'Failed to close shift');
    }
    setIsEnding(false);
  };

  if (loading) {
    return (
      <div className="card-glass p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <>
      <div className="card-glass relative overflow-hidden group">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-indigo-600"></div>
        
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-2xl ${currentShift ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-600' : 'bg-blue-100 dark:bg-blue-900/20 text-blue-600'}`}>
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-black">Shift Management</h2>
              <p className="text-xs text-slate-500 font-bold mt-0.5">
                {currentShift ? 'Active shift in progress' : 'No active shift'}
              </p>
            </div>
          </div>
        </div>

        {currentShift ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800/30">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-black text-emerald-700 dark:text-emerald-400">Start Time</span>
                <span className="text-sm font-bold">{new Date(currentShift.shift_start).toLocaleTimeString('en-US')}</span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-black text-emerald-700 dark:text-emerald-400">Opening Balance</span>
                <span className="text-sm font-black">EGP {currentShift.starting_cash_amount}</span>
              </div>
              {shiftStats && (
                <>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-black text-blue-700 dark:text-blue-400">Total Sales</span>
                    <span className="text-sm font-black text-blue-600">EGP {shiftStats.revenue}</span>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-emerald-200 dark:border-emerald-800">
                    <span className="text-xs font-black text-slate-700 dark:text-slate-300">Expected Cash</span>
                    <span className="text-md font-black text-slate-900 dark:text-white">EGP {shiftStats.expected_cash}</span>
                  </div>
                </>
              )}
            </div>
            
            <button
              onClick={() => {
                setEndingCash(shiftStats?.expected_cash?.toString() || '');
                setShowEndModal(true);
              }}
              className="w-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 py-4 rounded-2xl font-black text-lg transition-all shadow-lg hover:bg-slate-800 dark:hover:bg-slate-100 flex items-center justify-center gap-2 group-hover:scale-[1.02] transform"
            >
              <StopCircle className="w-5 h-5" />
              End & Close Shift
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
              You must start a new shift before recording any sales or cash transactions.
            </p>
            <button
              onClick={() => setShowStartModal(true)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-black text-lg transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2 group-hover:scale-[1.02] transform"
            >
              <Play className="w-5 h-5 fill-current" />
              Start New Shift
            </button>
          </div>
        )}
      </div>

      {/* Start Shift Modal */}
      {showStartModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[150] p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-300">
            <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-6 text-white flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black">Start New Shift</h3>
                <p className="text-blue-100 text-xs mt-1">Enter the current cash in drawer</p>
              </div>
              <button onClick={() => setShowStartModal(false)} className="text-2xl font-bold">&times;</button>
            </div>

            <form onSubmit={handleStartShift} className="p-8 space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-black text-slate-700 dark:text-slate-300 ml-2">Opening Cash (EGP)</label>
                <div className="relative">
                  <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    autoFocus
                    value={startingCash}
                    onChange={(e) => setStartingCash(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pl-12 pr-4 py-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-black text-lg"
                    placeholder="0.00"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isStarting}
                className="w-full bg-emerald-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isStarting ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <span>🚀</span>
                    <span>Confirm & Start Work</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* End Shift Modal */}
      {showEndModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[150] p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-300">
            <div className="bg-gradient-to-r from-red-600 to-rose-600 p-6 text-white flex justify-between items-center">
              <div>
                <h3 className="text-xl font-black">Close Shift</h3>
                <p className="text-rose-100 text-xs mt-1">Verify physical cash in drawer</p>
              </div>
              <button onClick={() => setShowEndModal(false)} className="text-2xl font-bold">&times;</button>
            </div>

            <form onSubmit={handleEndShift} className="p-8 space-y-6">
              {shiftStats && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Sales</p>
                    <p className="text-lg font-black text-blue-600">EGP {shiftStats.revenue}</p>
                  </div>
                  <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Transactions</p>
                    <p className="text-lg font-black text-emerald-600">{shiftStats.transactions}</p>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-sm font-black text-slate-700 dark:text-slate-300 ml-2">Final Cash (Actual in Drawer)</label>
                <div className="relative">
                  <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    autoFocus
                    value={endingCash}
                    onChange={(e) => setEndingCash(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pl-12 pr-4 py-4 rounded-2xl focus:ring-2 focus:ring-red-500 outline-none transition-all font-black text-lg"
                    placeholder="0.00"
                  />
                </div>
                {shiftStats && (
                   <p className="text-[10px] font-bold text-slate-500 mt-2 text-center">
                     Expected System Balance: <span className="text-slate-900 dark:text-white">EGP {shiftStats.expected_cash}</span>
                   </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isEnding}
                className="w-full bg-red-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-red-700 transition-all shadow-xl shadow-red-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isEnding ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <span>🔒</span>
                    <span>Confirm Closure & Post</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
