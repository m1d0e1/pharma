import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import HeaderAlerts from '@/components/HeaderAlerts';
import ThemeToggle from '@/components/ThemeToggle';
import JobsManagementClient from '@/components/admin/JobsManagementClient';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { getInventoryAlertsAction } from '@/app/actions-client/inventory';
import { hasUserPermissionSync } from '@/lib/auth/local';

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush, refresh: jest.fn() }),
}));

jest.mock('@/lib/auth/local', () => ({
  hasUserPermissionSync: jest.fn(() => true),
  logoutLocal: jest.fn(),
}));

jest.mock('@/app/actions-client/inventory', () => ({
  getInventoryAlertsAction: jest.fn(),
}));

jest.mock('@/lib/inventory/refresh', () => ({
  subscribeInventoryChanges: jest.fn(() => () => undefined),
}));

jest.mock('@/app/actions-client/interactions', () => ({
  addInteractionAction: jest.fn(),
  checkDrugInteractions: jest.fn(),
  getInteractionsAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('remaining module UI accessibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);
  });

  it('gives theme and alert icon controls descriptive accessible names', async () => {
    (getInventoryAlertsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        alerts: [{
          id: 'drug-1',
          alert_type: 'low_stock',
          trade_name_en: 'Drug A',
          quantity: 2,
        }],
      },
    });

    render(
      <>
        <ThemeToggle />
        <HeaderAlerts />
      </>,
    );

    const themeButton = screen.getByRole('button', { name: 'التبديل للوضع الليلي' });
    fireEvent.click(themeButton);
    expect(screen.getByRole('button', { name: 'التبديل للوضع النهاري' })).toBeInTheDocument();

    const alertsButton = await screen.findByRole('button', { name: 'فتح التنبيهات (1)' });
    fireEvent.click(alertsButton);

    const dismiss = screen.getByRole('button', { name: 'تحديد تنبيه Drug A كمقروء وإخفاؤه' });
    expect(dismiss).toBeInTheDocument();
    expect(dismiss.parentElement).toHaveClass('sm:group-focus-within:opacity-100');
  });

  it('keeps job actions keyboard-reachable and associates labels with form fields', () => {
    render(
      <JobsManagementClient
        initialJobs={[{
          id: 1,
          name_ar: 'صيدلي',
          name_en: null,
          min_salary: 5000,
          max_salary: 7000,
        }]}
        onAddJob={jest.fn().mockResolvedValue({ success: true })}
        onDeleteJob={jest.fn().mockResolvedValue({ success: true })}
      />,
    );

    const deleteButton = screen.getByRole('button', { name: 'حذف وظيفة صيدلي' });
    expect(deleteButton).toHaveClass('focus:opacity-100');
    expect(screen.getByLabelText('المسمى (بالعربي)')).toBeInTheDocument();
    expect(screen.getByLabelText('المسمى (بالإنجليزي)')).toBeInTheDocument();
    expect(screen.getByLabelText('أقل مرتب')).toBeInTheDocument();
    expect(screen.getByLabelText('أعلى مرتب')).toBeInTheDocument();
    expect(screen.getByText('بدون اسم إنجليزي')).toBeInTheDocument();
  });

  it('names interaction search, add-form fields, and pagination controls', async () => {
    render(
      <InteractionsClient
        initialInteractions={[{
          id: 1,
          ingredient_a: 'warfarin',
          ingredient_b: 'aspirin',
          severity: 'moderate',
          description_ar: 'وصف',
          recommendation: '',
        }]}
        totalCount={100}
        userRole="owner"
      />,
    );

    expect(screen.getByRole('textbox', { name: 'المواد الفعالة للفحص السريع' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'بحث في التفاعلات الدوائية' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الصفحة السابقة' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'الصفحة التالية' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /إضافة تفاعل/ }));
    await waitFor(() => expect(screen.getByRole('form', { name: 'إضافة تفاعل دوائي جديد' })).toBeInTheDocument());
    expect(screen.getByLabelText('المادة الفعالة الأولى')).toBeInTheDocument();
    expect(screen.getByLabelText('المادة الفعالة الثانية')).toBeInTheDocument();
    expect(screen.getByLabelText('التوصية')).toBeInTheDocument();
    expect(screen.getByLabelText('وصف التفاعل بالتفصيل')).toBeInTheDocument();
  });
});
