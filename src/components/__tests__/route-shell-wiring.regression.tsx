import { render, screen } from '@testing-library/react';
import AccountsPage from '@/app/(dashboard)/accounts/page';
import CashTransactionsPage from '@/app/(dashboard)/accounts/cash-transactions/page';
import TrialBalanceSettingsPage from '@/app/(dashboard)/accounts/settings/trial-balance/page';
import FinanceAccountsPage from '@/app/(dashboard)/finance/accounts/page';
import BanksPage from '@/app/(dashboard)/finance/banks/page';
import CardsPage from '@/app/(dashboard)/finance/cards/page';
import PosManagementPage from '@/app/(dashboard)/finance/pos-management/page';
import EditReturnsPage from '@/app/(dashboard)/purchases/edit-returns/page';
import GeneralReturnsPage from '@/app/(dashboard)/purchases/general-returns/page';
import NewGeneralReturnPage from '@/app/(dashboard)/purchases/general-returns/new/page';
import NewPurchaseInvoicePage from '@/app/(dashboard)/purchases/new/page';
import PurchaseReturnsPage from '@/app/(dashboard)/purchases/returns/page';
import NewPurchaseReturnPage from '@/app/(dashboard)/purchases/returns/new/page';
import SettlementPage from '@/app/(dashboard)/sales/settlement/page';
import UnauthorizedPage from '@/app/(dashboard)/unauthorized/page';
import RootLayout from '@/app/layout';
import NotFound from '@/app/not-found';
import SetupPage from '@/app/setup/page';

const mockRedirect = jest.fn();

jest.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

jest.mock('next/link', () => function MockLink({ href, children, ...props }: any) {
  return <a href={href} {...props}>{children}</a>;
});

jest.mock('react-hot-toast', () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

jest.mock('@/components/AppInitializer', () => function MockAppInitializer({ children }: any) {
  return <div data-testid="app-initializer">{children}</div>;
});

jest.mock('@/components/PermissionGuard', () => function MockPermissionGuard({ permissionKey, children }: any) {
  return <div data-testid={`guard-${permissionKey}`}>{children}</div>;
});

jest.mock('@/components/finance/AccountsManagementClient', () => function MockAccountsManagementClient({ initialTab }: any) {
  return <div data-testid={`accounts-${initialTab || 'default'}`} />;
});

jest.mock('@/components/finance/CashTransactionsClient', () => function MockCashTransactionsClient() {
  return <div data-testid="cash-transactions-client" />;
});

jest.mock('@/components/finance/TrialBalanceSettingsClient', () => function MockTrialBalanceSettingsClient() {
  return <div data-testid="trial-balance-settings-client" />;
});

jest.mock('@/app/(dashboard)/purchases/new/PurchaseInvoiceClient', () => function MockPurchaseInvoiceClient() {
  return <div data-testid="purchase-invoice-client" />;
});

jest.mock('@/components/returns/ReturnsClient', () => function MockReturnsClient({ type }: any) {
  return <div data-testid={`returns-client-${type}`} />;
});

jest.mock('@/app/(dashboard)/purchases/returns/new/PurchaseReturnClient', () => function MockPurchaseReturnClient() {
  return <div data-testid="purchase-return-client" />;
});

jest.mock('@/components/sales/SettlementClient', () => function MockSettlementClient() {
  return <div data-testid="settlement-client" />;
});

jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>access-denied</div>;
});

describe('thin route shell wiring', () => {
  beforeEach(() => {
    mockRedirect.mockClear();
  });

  it.each([
    [AccountsPage, 'acc_can_view_general', 'accounts-default'],
    [FinanceAccountsPage, 'acc_can_view_general', 'accounts-chart_of_accounts'],
    [BanksPage, 'acc_can_view_bank_accounts', 'accounts-banks'],
    [CardsPage, 'acc_can_collect_credit_cards', 'accounts-cards'],
    [PosManagementPage, 'acc_can_view_pos', 'accounts-pos_management'],
  ])('wires finance route permissions and initial account tabs', (Page, permissionKey, clientTestId) => {
    render(<Page />);

    expect(screen.getByTestId(`guard-${permissionKey}`)).toBeInTheDocument();
    expect(screen.getByTestId(clientTestId)).toBeInTheDocument();
  });

  it('wires cash movements and trial-balance settings to their guarded clients', () => {
    const cash = render(<CashTransactionsPage />);
    expect(screen.getByTestId('guard-acc_can_process_cash_flow')).toBeInTheDocument();
    expect(screen.getByTestId('cash-transactions-client')).toBeInTheDocument();
    cash.unmount();

    render(<TrialBalanceSettingsPage />);
    expect(screen.getByTestId('guard-acc_can_view_general')).toBeInTheDocument();
    expect(screen.getByTestId('trial-balance-settings-client')).toBeInTheDocument();
  });

  it('wires active purchase and settlement route shells to the exercised clients', () => {
    const invoice = render(<NewPurchaseInvoicePage />);
    expect(screen.getByTestId('purchase-invoice-client')).toBeInTheDocument();
    invoice.unmount();

    const returns = render(<PurchaseReturnsPage />);
    expect(screen.getByTestId('returns-client-purchases')).toBeInTheDocument();
    returns.unmount();

    const newReturn = render(<NewPurchaseReturnPage />);
    expect(screen.getByTestId('purchase-return-client')).toBeInTheDocument();
    newReturn.unmount();

    render(<SettlementPage />);
    expect(screen.getByTestId('guard-can_view_settlement')).toBeInTheDocument();
    expect(screen.getByTestId('settlement-client')).toBeInTheDocument();
  });

  it('keeps legacy and setup navigation redirects pointed at their supported destinations', () => {
    EditReturnsPage();
    GeneralReturnsPage();
    SetupPage();

    expect(mockRedirect.mock.calls).toEqual([
      ['/purchases/returns'],
      ['/purchases/returns'],
      ['/login'],
    ]);
  });

  it('renders the direct placeholder, unauthorized state, and 404 recovery navigation', () => {
    const placeholder = render(<NewGeneralReturnPage />);
    expect(screen.getByText('جاري العمل على هذه الصفحة')).toBeInTheDocument();
    placeholder.unmount();

    const unauthorized = render(<UnauthorizedPage />);
    expect(screen.getByText('access-denied')).toBeInTheDocument();
    unauthorized.unmount();

    render(<NotFound />);
    expect(screen.getByRole('link', { name: 'العودة للرئيسية' })).toHaveAttribute('href', '/');
  });

  it('keeps the root shell RTL and normalizes exported .html paths before app startup', () => {
    const root = RootLayout({ children: <div>root-child</div> }) as any;
    expect(root.type).toBe('html');
    expect(root.props.lang).toBe('ar');
    expect(root.props.dir).toBe('rtl');

    const children = Array.isArray(root.props.children) ? root.props.children : [root.props.children];
    const head = children.find((child: any) => child?.type === 'head');
    const script = head?.props?.children?.props?.dangerouslySetInnerHTML?.__html;
    expect(script).toContain('window.history.replaceState');

    window.history.replaceState(null, '', '/reports/index.html');
    const replaceState = jest.spyOn(window.history, 'replaceState');
    Function(script)();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/reports');
    replaceState.mockRestore();
  });
});
