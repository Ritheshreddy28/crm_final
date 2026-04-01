import { createClient } from '@supabase/supabase-js';
import { BACKEND_ENV } from './backendConfig';

const supabaseUrl = BACKEND_ENV.supabaseUrl;
const supabaseAnonKey = BACKEND_ENV.supabaseAnonKey;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface PaymentRecord {
  id: string;
  user_id: string;
  recipient_name: string;
  payment_method: string;
  payment_currency: string;
  payment_amount: number;
  payment_date: string;
  receiver_bank_holder: string;
  sender_name: string | null;
  submitted_by_email: string | null;
  requirements: string | null;
  payment_screenshot_url: string;
  utr_number: string | null;
  payment_type: string;
  created_at: string;
}
