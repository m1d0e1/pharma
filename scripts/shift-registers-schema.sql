-- Shift Registers & Shrinkage Auditing Schema
-- This script adds shift cash management and void transaction tracking

-- ==========================================
-- 1. SHIFT_REGISTERS TABLE (Enhanced from existing shifts table)
-- ==========================================

-- Drop existing shifts table if it exists and recreate as shift_registers
DROP TABLE IF EXISTS shifts CASCADE;

CREATE TABLE shift_registers (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- Shift timing
    shift_start TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    shift_end TIMESTAMP WITH TIME ZONE,
    
    -- Cash management
    starting_cash_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    ending_cash_amount NUMERIC(10, 2),
    expected_cash_amount NUMERIC(10, 2), -- Calculated based on transactions
    cash_difference NUMERIC(10, 2), -- ending_cash_amount - expected_cash_amount
    
    -- Electronic payments
    card_transactions_total NUMERIC(10, 2) DEFAULT 0.00,
    mobile_payments_total NUMERIC(10, 2) DEFAULT 0.00,
    
    -- Transaction counts
    total_transactions INTEGER DEFAULT 0,
    total_sales_amount NUMERIC(10, 2) DEFAULT 0.00,
    
    -- Void tracking
    voided_transactions_count INTEGER DEFAULT 0,
    voided_amount_total NUMERIC(10, 2) DEFAULT 0.00,
    
    -- Shift status
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending_review', 'discrepancy')),
    
    -- Verification
    verified_by UUID REFERENCES profiles(id),
    verified_at TIMESTAMP WITH TIME ZONE,
    verification_notes TEXT,
    
    -- Notes
    opening_notes TEXT,
    closing_notes TEXT,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Constraints
    CONSTRAINT valid_cash_amounts CHECK (starting_cash_amount >= 0 AND (ending_cash_amount IS NULL OR ending_cash_amount >= 0)),
    CONSTRAINT valid_shift_times CHECK (shift_end IS NULL OR shift_end > shift_start)
);

-- Indexes for shift_registers
CREATE INDEX idx_shift_registers_pharmacy_id ON shift_registers(pharmacy_id);
CREATE INDEX idx_shift_registers_user_id ON shift_registers(user_id);
CREATE INDEX idx_shift_registers_status ON shift_registers(status);
CREATE INDEX idx_shift_registers_shift_start ON shift_registers(shift_start);
CREATE INDEX idx_shift_registers_pharmacy_status ON shift_registers(pharmacy_id, status) WHERE status = 'open';

-- ==========================================
-- 2. VOIDED_TRANSACTIONS TABLE
-- ==========================================

CREATE TABLE voided_transactions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    
    -- Reference to original transaction
    invoice_id UUID REFERENCES sales_invoices(id) ON DELETE SET NULL,
    shift_register_id UUID NOT NULL REFERENCES shift_registers(id) ON DELETE CASCADE,
    
    -- Transaction details
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('full_invoice', 'partial_item', 'price_adjustment', 'discount')),
    original_amount NUMERIC(10, 2) NOT NULL,
    voided_amount NUMERIC(10, 2) NOT NULL,
    
    -- Item details (for partial voids)
    inventory_id UUID REFERENCES inventory(id),
    drug_id BIGINT REFERENCES master_drugs(id),
    quantity_voided NUMERIC(10, 4) DEFAULT 0,
    
    -- Reason and authorization
    void_reason TEXT NOT NULL,
    authorized_by UUID REFERENCES profiles(id), -- Supervisor who authorized void
    authorization_required BOOLEAN DEFAULT FALSE,
    authorization_code TEXT, -- Code entered for authorization
    
    -- User and shift context
    voided_by UUID NOT NULL REFERENCES profiles(id),
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    
    -- Timestamps
    transaction_time TIMESTAMP WITH TIME ZONE NOT NULL, -- When original transaction occurred
    voided_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Audit trail
    ip_address INET,
    user_agent TEXT,
    
    -- Reconciliation
    reconciled BOOLEAN DEFAULT FALSE,
    reconciled_by UUID REFERENCES profiles(id),
    reconciled_at TIMESTAMP WITH TIME ZONE,
    
    -- Notes
    notes TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for voided_transactions
CREATE INDEX idx_voided_transactions_shift_register ON voided_transactions(shift_register_id);
CREATE INDEX idx_voided_transactions_pharmacy ON voided_transactions(pharmacy_id);
CREATE INDEX idx_voided_transactions_voided_by ON voided_transactions(voided_by);
CREATE INDEX idx_voided_transactions_voided_at ON voided_transactions(voided_at);
CREATE INDEX idx_voided_transactions_invoice ON voided_transactions(invoice_id);
CREATE INDEX idx_voided_transactions_reconciled ON voided_transactions(reconciled) WHERE reconciled = FALSE;

-- ==========================================
-- 3. SHIFT_AUDIT_LOGS TABLE (For detailed audit trail)
-- ==========================================

CREATE TABLE shift_audit_logs (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    shift_register_id UUID NOT NULL REFERENCES shift_registers(id) ON DELETE CASCADE,
    
    action_type TEXT NOT NULL CHECK (action_type IN (
        'shift_open', 'shift_close', 'cash_adjustment', 'void_authorization',
        'override', 'discount_applied', 'price_override', 'manual_transaction'
    )),
    
    -- User context
    performed_by UUID NOT NULL REFERENCES profiles(id),
    pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    
    -- Action details
    details JSONB NOT NULL DEFAULT '{}',
    previous_value TEXT,
    new_value TEXT,
    
    -- Authorization
    requires_authorization BOOLEAN DEFAULT FALSE,
    authorized_by UUID REFERENCES profiles(id),
    authorization_notes TEXT,
    
    -- Timestamps
    performed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Device/context info
    ip_address INET,
    user_agent TEXT,
    device_id TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for shift_audit_logs
CREATE INDEX idx_shift_audit_logs_shift ON shift_audit_logs(shift_register_id);
CREATE INDEX idx_shift_audit_logs_pharmacy ON shift_audit_logs(pharmacy_id);
CREATE INDEX idx_shift_audit_logs_performed_at ON shift_audit_logs(performed_at);
CREATE INDEX idx_shift_audit_logs_action_type ON shift_audit_logs(action_type);

-- ==========================================
-- 4. FUNCTIONS AND TRIGGERS
-- ==========================================

-- Function to automatically update shift register totals
CREATE OR REPLACE FUNCTION update_shift_totals()
RETURNS TRIGGER AS $$
BEGIN
    -- Update shift register totals when a sale is made
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'sales_invoices' THEN
        UPDATE shift_registers 
        SET 
            total_transactions = total_transactions + 1,
            total_sales_amount = total_sales_amount + NEW.total_amount,
            expected_cash_amount = COALESCE(expected_cash_amount, 0) + NEW.total_amount,
            updated_at = NOW()
        WHERE id = (
            SELECT id FROM shift_registers 
            WHERE pharmacy_id = NEW.pharmacy_id 
            AND user_id = NEW.user_id 
            AND status = 'open'
            LIMIT 1
        );
    END IF;
    
    -- Update void counts when a transaction is voided
    IF TG_OP = 'INSERT' AND TG_TABLE_NAME = 'voided_transactions' THEN
        UPDATE shift_registers 
        SET 
            voided_transactions_count = voided_transactions_count + 1,
            voided_amount_total = voided_amount_total + NEW.voided_amount,
            expected_cash_amount = COALESCE(expected_cash_amount, 0) - NEW.voided_amount,
            updated_at = NOW()
        WHERE id = NEW.shift_register_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for sales_invoices
DROP TRIGGER IF EXISTS trg_update_shift_on_sale ON sales_invoices;
CREATE TRIGGER trg_update_shift_on_sale
    AFTER INSERT ON sales_invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_shift_totals();

-- Trigger for voided_transactions
DROP TRIGGER IF EXISTS trg_update_shift_on_void ON voided_transactions;
CREATE TRIGGER trg_update_shift_on_void
    AFTER INSERT ON voided_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_shift_totals();

-- Function to close a shift and calculate discrepancies
CREATE OR REPLACE FUNCTION close_shift_register(
    p_shift_id UUID,
    p_ending_cash_amount NUMERIC,
    p_closing_notes TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_shift_record shift_registers%ROWTYPE;
    v_discrepancy NUMERIC;
    v_status TEXT;
BEGIN
    -- Get shift details
    SELECT * INTO v_shift_record 
    FROM shift_registers 
    WHERE id = p_shift_id 
    AND status = 'open';
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Shift not found or already closed'
        );
    END IF;
    
    -- Calculate discrepancy
    v_discrepancy := p_ending_cash_amount - COALESCE(v_shift_record.expected_cash_amount, 0);
    
    -- Determine status based on discrepancy
    IF ABS(v_discrepancy) <= 5.00 THEN -- Allow $5 tolerance
        v_status := 'closed';
    ELSE
        v_status := 'discrepancy';
    END IF;
    
    -- Update shift register
    UPDATE shift_registers 
    SET 
        shift_end = NOW(),
        ending_cash_amount = p_ending_cash_amount,
        cash_difference = v_discrepancy,
        status = v_status,
        closing_notes = p_closing_notes,
        updated_at = NOW()
    WHERE id = p_shift_id;
    
    -- Log the closure
    INSERT INTO shift_audit_logs (
        shift_register_id,
        action_type,
        performed_by,
        pharmacy_id,
        details,
        previous_value,
        new_value
    ) VALUES (
        p_shift_id,
        'shift_close',
        v_shift_record.user_id,
        v_shift_record.pharmacy_id,
        jsonb_build_object(
            'ending_cash', p_ending_cash_amount,
            'expected_cash', v_shift_record.expected_cash_amount,
            'discrepancy', v_discrepancy,
            'tolerance', 5.00
        ),
        'open',
        v_status
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'shift_id', p_shift_id,
        'status', v_status,
        'discrepancy', v_discrepancy,
        'requires_review', v_status = 'discrepancy'
    );
END;
$$ LANGUAGE plpgsql;

-- Function to get shrinkage report
CREATE OR REPLACE FUNCTION get_shrinkage_report(
    p_pharmacy_id UUID,
    p_start_date DATE DEFAULT NULL,
    p_end_date DATE DEFAULT NULL
)
RETURNS TABLE (
    shift_date DATE,
    user_name TEXT,
    total_sales NUMERIC,
    total_voids NUMERIC,
    void_percentage NUMERIC,
    cash_discrepancy NUMERIC,
    shift_status TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        DATE(sr.shift_start) as shift_date,
        p.full_name as user_name,
        sr.total_sales_amount as total_sales,
        sr.voided_amount_total as total_voids,
        CASE 
            WHEN sr.total_sales_amount > 0 THEN 
                (sr.voided_amount_total / sr.total_sales_amount) * 100 
            ELSE 0 
        END as void_percentage,
        sr.cash_difference as cash_discrepancy,
        sr.status as shift_status
    FROM shift_registers sr
    JOIN profiles p ON sr.user_id = p.id
    WHERE sr.pharmacy_id = p_pharmacy_id
    AND sr.status != 'open'
    AND (p_start_date IS NULL OR DATE(sr.shift_start) >= p_start_date)
    AND (p_end_date IS NULL OR DATE(sr.shift_start) <= p_end_date)
    ORDER BY sr.shift_start DESC;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 5. VIEWS FOR REPORTING
-- ==========================================

-- View for daily shift summary
CREATE OR REPLACE VIEW shift_daily_summary AS
SELECT 
    sr.pharmacy_id,
    DATE(sr.shift_start) as shift_date,
    COUNT(*) as total_shifts,
    COUNT(CASE WHEN sr.status = 'discrepancy' THEN 1 END) as shifts_with_discrepancy,
    SUM(sr.total_sales_amount) as total_sales,
    SUM(sr.voided_amount_total) as total_voids,
    AVG(CASE 
        WHEN sr.total_sales_amount > 0 THEN 
            (sr.voided_amount_total / sr.total_sales_amount) * 100 
        ELSE 0 
    END) as avg_void_percentage,
    SUM(ABS(sr.cash_difference)) as total_cash_discrepancy
FROM shift_registers sr
WHERE sr.status != 'open'
GROUP BY sr.pharmacy_id, DATE(sr.shift_start);

-- View for employee performance (shrinkage)
CREATE OR REPLACE VIEW employee_shrinkage_report AS
SELECT 
    sr.pharmacy_id,
    sr.user_id,
    p.full_name,
    p.role,
    COUNT(*) as total_shifts,
    COUNT(CASE WHEN sr.status = 'discrepancy' THEN 1 END) as problematic_shifts,
    SUM(sr.total_sales_amount) as total_sales,
    SUM(sr.voided_amount_total) as total_voids,
    AVG(CASE 
        WHEN sr.total_sales_amount > 0 THEN 
            (sr.voided_amount_total / sr.total_sales_amount) * 100 
        ELSE 0 
    END) as avg_void_percentage,
    SUM(ABS(sr.cash_difference)) as total_cash_discrepancy,
    RANK() OVER (PARTITION BY sr.pharmacy_id ORDER BY SUM(sr.voided_amount_total) DESC) as void_rank
FROM shift_registers sr
JOIN profiles p ON sr.user_id = p.id
WHERE sr.status != 'open'
GROUP BY sr.pharmacy_id, sr.user_id, p.full_name, p.role;

-- ==========================================
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- ==========================================

-- Enable RLS on new tables
ALTER TABLE shift_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE voided_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_audit_logs ENABLE ROW LEVEL SECURITY;

-- Policies for shift_registers
CREATE POLICY shift_registers_pharmacy_policy ON shift_registers
    FOR ALL USING (pharmacy_id IN (
        SELECT pharmacy_id FROM profiles WHERE id = auth.uid()
    ));

-- Policies for voided_transactions
CREATE POLICY voided_transactions_pharmacy_policy ON voided_transactions
    FOR ALL USING (pharmacy_id IN (
        SELECT pharmacy_id FROM profiles WHERE id = auth.uid()
    ));

-- Policies for shift_audit_logs
CREATE POLICY shift_audit_logs_pharmacy_policy ON shift_audit_logs
    FOR ALL USING (pharmacy_id IN (
        SELECT pharmacy_id FROM profiles WHERE id = auth.uid()
    ));

-- ==========================================
-- 7. COMMENTS
-- ==========================================

COMMENT ON TABLE shift_registers IS 'Tracks cash register shifts with opening/closing balances and discrepancy detection';
COMMENT ON TABLE voided_transactions IS 'Logs all voided transactions for shrinkage auditing and fraud detection';
COMMENT ON TABLE shift_audit_logs IS 'Detailed audit trail of all shift-related actions for compliance';

COMMENT ON COLUMN shift_registers.cash_difference IS 'Positive = overage, Negative = shortage';
COMMENT ON COLUMN shift_registers.void_percentage IS 'Percentage of sales that were voided (key shrinkage metric)';
COMMENT ON COLUMN voided_transactions.authorization_required IS 'Whether supervisor authorization was required for this void';
COMMENT ON COLUMN voided_transactions.authorization_code IS 'Supervisor code entered to authorize void';

-- ==========================================
-- 8. INITIAL DATA (Optional - for testing)
-- ==========================================

-- Uncomment for testing environments
/*
INSERT INTO shift_registers (
    pharmacy_id, user_id, starting_cash_amount, status
) VALUES (
    (SELECT id FROM pharmacies LIMIT 1),
    (SELECT id FROM profiles WHERE role = 'pharmacist' LIMIT 1),
    500.00,
    'open'
);
*/