/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, PaymentRecord } from '../lib/supabase';

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function screenshotExistsInDb(hash: string): Promise<boolean> {
  if (!hash || hash.length < 10) return false;
  const { data, error } = await supabase.rpc('screenshot_hash_exists', { p_hash: hash });
  if (!error && data === true) return true;
  const [pr, sp, sh] = await Promise.all([
    supabase.from('payment_records').select('id').eq('screenshot_hash', hash).limit(1).maybeSingle(),
    supabase.from('student_payments').select('id').eq('screenshot_hash', hash).limit(1).maybeSingle(),
    supabase.from('screenshot_hashes').select('hash').eq('hash', hash).limit(1).maybeSingle(),
  ]);
  return !!(pr.data?.id || sp.data?.id || sh.data?.hash);
}

/** Extract storage path from Supabase URL or return path as-is if already a path */
function getScreenshotStoragePath(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string' || !url.trim()) return null;
  const trimmed = url.trim();
  // Full URL: .../payment-screenshots/path or .../object/public/payment-screenshots/path
  const after = trimmed.split('/payment-screenshots/')[1];
  if (after) {
    const path = after.split('?')[0].trim();
    return path || null;
  }
  // Path only: user_id/file.jpg (no protocol)
  if (!trimmed.includes('://') && trimmed.includes('/')) {
    return trimmed.split('?')[0].trim();
  }
  return null;
}

/** Get a signed URL for a payment screenshot (works with private buckets) */
async function getSignedScreenshotUrl(urlOrPath: string | null | undefined): Promise<string | null> {
  const path = getScreenshotStoragePath(urlOrPath);
  if (!path) return typeof urlOrPath === 'string' ? urlOrPath : null;
  const { data } = await supabase.storage
    .from('payment-screenshots')
    .createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

import { LogOut, Shield, Eye, X, Loader2, Calendar, DollarSign, User, Building, FileText, CreditCard, Hash, BarChart3, Clock, Trash2, GraduationCap, Mail, BookOpen, Plus, Lock, Search, Edit, FileSpreadsheet, Upload, Check, Download, AlertCircle, Users, Wallet, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, AlertTriangle, Timer, ImageIcon } from 'lucide-react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../lib/currency';
import {
  REMINDER_API_URLS,
  isReminderApiConfigured,
  isReminderFetchNetworkError,
  reminderApiNetworkErrorHint,
} from '../lib/backendConfig';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

const PAYMENT_METHODS = ['Bank Transfer', 'Credit Card', 'Debit Card', 'PayPal', 'Zelle', 'Cryptocurrency', 'Cash', 'UPI', 'Other'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'INR', 'Other'];
const FUTURE_PAYMENT_CATEGORIES = ['Salary', 'Investment Return', 'Loan Payment', 'Vendor Payment', 'Rent', 'Invoice', 'Other'];
const PAYMENT_STATUSES = ['unpaid', 'paid_partially', 'paid_completely'];

interface FuturePayment {
  id: string;
  user_id: string;
  sender_name: string;
  email?: string | null;
  amount: number;
  category: string;
  custom_category: string;
  currency: string;
  payment_date: string;
  notes: string;
  status?: string;
  created_at: string;
}

interface StudentRecord {
  id: string;
  user_id: string;
  student_name: string;
  email: string | null;
  password: string | null;
  phone_number: string | null;
  university: string | null;
  subjects: string | null;
  is_critical?: boolean;
  additional_info: Record<string, any>;
  created_at: string;
  updated_at: string;
}

interface StudentPayment {
  id: string;
  user_id: string;
  student_id: string;
  payment_mode: string;
  currency: string;
  amount: number;
  payment_status: string;
  balance_amount: number;
  payment_date: string | null;
  credited_to: string | null;
  payment_screenshot_url: string | null;
  payment_screenshot_urls: string[];
  subjects: string | null;
  created_at: string;
  updated_at: string;
}

type TabType = 'overview' | 'payments' | 'future' | 'students' | 'excelUploads' | 'timeSpent';

interface LoginHistoryEntry {
  id: string;
  user_id: string;
  email: string | null;
  login_at: string;
  logout_at: string | null;
  duration_seconds: number | null;
}

interface ExcelUpload {
  id: string;
  user_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  upload_type: 'admin' | 'user';
  records_count: number;
  created_at: string;
}

export function AdminDashboard() {
  const { user, signOut } = useAuth();
  console.log('Admin Dashboard - User:', user);
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [records, setRecords] = useState<PaymentRecord[]>([]);
  const [futurePayments, setFuturePayments] = useState<FuturePayment[]>([]);
  const [studentRecords, setStudentRecords] = useState<StudentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [futurePaymentsLoading, setFuturePaymentsLoading] = useState(true);
  const [studentRecordsLoading, setStudentRecordsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedStudentForPopup, setSelectedStudentForPopup] = useState<StudentRecord | null>(null);
  const [showAddStudentModal, setShowAddStudentModal] = useState(false);
  const [addStudentMode, setAddStudentMode] = useState<'manual' | 'bulk'>('manual');
  const [newStudentData, setNewStudentData] = useState({
    student_name: '',
    email: '',
    password: '',
    phone_number: '',
    university: '',
    subjects: '',
  });
  const [addStudentLoading, setAddStudentLoading] = useState(false);
  const [studentExcelFile, setStudentExcelFile] = useState<File | null>(null);
  const [uploadedRecordsCount, setUploadedRecordsCount] = useState(0);
  const [bulkUploadSuccess, setBulkUploadSuccess] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [paymentRecordsSearchQuery, setPaymentRecordsSearchQuery] = useState('');
  const [futurePaymentsSearchQuery, setFuturePaymentsSearchQuery] = useState('');
  const [showEditFuturePaymentModal, setShowEditFuturePaymentModal] = useState(false);
  const [selectedFuturePaymentForEdit, setSelectedFuturePaymentForEdit] = useState<FuturePayment | null>(null);
  const [editFuturePaymentData, setEditFuturePaymentData] = useState({
    sender_name: '',
    email: '',
    currency: 'USD',
    amount: '',
    category: '',
    customCategory: '',
    payment_date: '',
    notes: '',
  });
  const [editFuturePaymentLoading, setEditFuturePaymentLoading] = useState(false);
  const [showAddFuturePaymentModal, setShowAddFuturePaymentModal] = useState(false);
  const [addFuturePaymentData, setAddFuturePaymentData] = useState({
    sender_name: '',
    email: '',
    currency: 'USD',
    amount: '',
    category: '',
    customCategory: '',
    payment_date: '',
    notes: '',
  });
  const [addFuturePaymentLoading, setAddFuturePaymentLoading] = useState(false);
  const [exportFilters, setExportFilters] = useState({
    university: '',
    startDate: '',
    endDate: '',
    includeSubjects: true,
  });
  const [showExportModal, setShowExportModal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showEditStudentModal, setShowEditStudentModal] = useState(false);
  const [editingStudent, setEditingStudent] = useState<StudentRecord | null>(null);
  const [editStudentData, setEditStudentData] = useState({
    student_name: '',
    email: '',
    password: '',
    phone_number: '',
    university: '',
    subjects: '',
  });
  const [editStudentLoading, setEditStudentLoading] = useState(false);
  const [studentPayments, setStudentPayments] = useState<StudentPayment[]>([]);
  const [studentPaymentsLoading, setStudentPaymentsLoading] = useState(false);
  const [showAddPaymentModal, setShowAddPaymentModal] = useState(false);
  const [addPaymentLoading, setAddPaymentLoading] = useState(false);
  const [newPaymentData, setNewPaymentData] = useState({
    payment_mode: '',
    currency: 'USD',
    amount: '',
    payment_status: 'unpaid',
    balance_amount: '',
    payment_date: '',
    credited_to: '',
    subjects: '',
  });
  const [addPaymentScreenshot, setAddPaymentScreenshot] = useState<File | null>(null);
  const [addPaymentScreenshotPreview, setAddPaymentScreenshotPreview] = useState('');
  const [showEditPaymentModal, setShowEditPaymentModal] = useState(false);
  const [editingPayment, setEditingPayment] = useState<StudentPayment | null>(null);
  const [editPaymentData, setEditPaymentData] = useState({
    payment_mode: '',
    currency: 'USD',
    amount: '',
    payment_status: 'unpaid',
    balance_amount: '',
    payment_date: '',
    credited_to: '',
    subjects: '',
  });
  const [editPaymentLoading, setEditPaymentLoading] = useState(false);
  const [excelUploads, setExcelUploads] = useState<ExcelUpload[]>([]);
  const [excelUploadsLoading, setExcelUploadsLoading] = useState(true);
  const [selectedExcelFile, setSelectedExcelFile] = useState<ExcelUpload | null>(null);
  const [excelPreviewData, setExcelPreviewData] = useState<any[]>([]);
  const [excelPreviewLoading, setExcelPreviewLoading] = useState(false);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<Date>(new Date());
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [creditedToSearchQuery, setCreditedToSearchQuery] = useState('');
  const [overviewExpandedCard, setOverviewExpandedCard] = useState<string | null>(null);
  const [overviewPieChartVariant, setOverviewPieChartVariant] = useState<'methods' | 'status'>('methods');
  const [reminderSending, setReminderSending] = useState(false);
  const [reminderMessage, setReminderMessage] = useState('');
  const [showReminderDropdown, setShowReminderDropdown] = useState(false);
  const [studentReminderSending, setStudentReminderSending] = useState(false);
  const [studentReminderMessage, setStudentReminderMessage] = useState('');
  const [collectedFilter, setCollectedFilter] = useState({
    dateFrom: '',
    dateTo: '',
    currency: 'all',
    type: 'all',
    paymentMethod: 'all',
  });
  const [loginHistory, setLoginHistory] = useState<LoginHistoryEntry[]>([]);
  const [loginHistoryLoading, setLoginHistoryLoading] = useState(false);

  const toLocalDateStr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  useEffect(() => {
    fetchRecords();
    fetchFuturePayments();
    fetchStudentRecords();
    fetchExcelUploads();
    fetchAllStudentPayments(); // Fetch all student payments for analytics
  }, []);

  useEffect(() => {
    if (selectedStudentForPopup) {
      console.log('Selected student for popup:', selectedStudentForPopup);
      fetchStudentPayments(selectedStudentForPopup.id);
    }
  }, [selectedStudentForPopup]);

  useEffect(() => {
    if (activeTab === 'timeSpent') fetchLoginHistory();
  }, [activeTab]);

  const fetchLoginHistory = async () => {
    setLoginHistoryLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_login_history')
        .select('id, user_id, email, login_at, logout_at, duration_seconds')
        .order('login_at', { ascending: false });
      if (error) throw error;
      setLoginHistory(data || []);
    } catch (err: any) {
      console.error('Failed to fetch login history:', err);
      setLoginHistory([]);
    } finally {
      setLoginHistoryLoading(false);
    }
  };

  const fetchRecords = async () => {
    try {
      const { data, error } = await supabase
        .from('payment_records')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const recordsWithSignedUrls = await Promise.all(
        (data || []).map(async (record) => {
          const signedUrl = await getSignedScreenshotUrl(record.payment_screenshot_url);
          return { ...record, payment_screenshot_url: signedUrl ?? record.payment_screenshot_url };
        })
      );

      setRecords(recordsWithSignedUrls);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch records');
    } finally {
      setLoading(false);
    }
  };

  const fetchFuturePayments = async () => {
    try {
      const { data, error } = await supabase
        .from('future_payments')
        .select('*')
        .order('payment_date', { ascending: true });

      if (error) throw error;

      setFuturePayments(data || []);
    } catch (err: any) {
      console.error('Failed to fetch future payments:', err);
    } finally {
      setFuturePaymentsLoading(false);
    }
  };

  const fetchStudentRecords = async () => {
    try {
      const { data, error } = await supabase
        .from('student_records')
        .select('*')
        .order('created_at', { ascending: false});

      if (error) throw error;

      setStudentRecords(data || []);
    } catch (err: any) {
      console.error('Failed to fetch student records:', err);
    } finally {
      setStudentRecordsLoading(false);
    }
  };

  const fetchAllStudentPayments = async () => {
    try {
      console.log('Fetching ALL student payments for analytics...');
      
      const { data, error } = await supabase
        .from('student_payments')
        .select('*')
        .order('created_at', { ascending: false });

      console.log('All student payments fetch result:', {
        data,
        error,
        dataLength: data?.length || 0,
      });

      if (error) {
        console.error('Failed to fetch all student payments:', error);
        throw error;
      }

      const paymentsWithSignedUrls = await Promise.all(
        (data || []).map(async (payment) => {
          const urlsToSign: string[] = (payment.payment_screenshot_urls && Array.isArray(payment.payment_screenshot_urls) && payment.payment_screenshot_urls.length > 0)
            ? payment.payment_screenshot_urls
            : (payment.payment_screenshot_url ? [payment.payment_screenshot_url] : []);
          const signedUrls = await Promise.all(
            urlsToSign.map(async (url) => (await getSignedScreenshotUrl(url)) ?? url)
          );
          return {
            ...payment,
            payment_screenshot_url: signedUrls[0] ?? payment.payment_screenshot_url,
            payment_screenshot_urls: signedUrls,
          };
        })
      );

      setStudentPayments(paymentsWithSignedUrls);
      console.log('Set student payments:', paymentsWithSignedUrls.length);
    } catch (err: any) {
      console.error('Failed to fetch all student payments:', err);
      setStudentPayments([]);
    }
  };

  const fetchStudentPayments = async (studentId: string) => {
    setStudentPaymentsLoading(true);
    try {
      console.log('Fetching payments for student_id:', studentId);

      const { data: authData } = await supabase.auth.getUser();
      console.log('Current user auth data:', authData);

      const { data, error, count } = await supabase
        .from('student_payments')
        .select('*', { count: 'exact' })
        .eq('student_id', studentId)
        .order('created_at', { ascending: false });

      console.log('Payment fetch result:', {
        data,
        error,
        count,
        dataLength: data?.length || 0,
        studentId
      });

      if (error) {
        console.error('Supabase error details:', error);
        throw error;
      }

      const paymentsWithSignedUrls = await Promise.all(
        (data || []).map(async (payment) => {
          const arr = payment.payment_screenshot_urls;
          const urlsToSign: string[] = (arr && Array.isArray(arr) && arr.length > 0)
            ? arr
            : (payment.payment_screenshot_url ? [payment.payment_screenshot_url] : []);
          const signedUrls = await Promise.all(
            urlsToSign.map(async (url) => (await getSignedScreenshotUrl(url)) ?? url)
          );
          return {
            ...payment,
            payment_screenshot_url: signedUrls[0] ?? payment.payment_screenshot_url,
            payment_screenshot_urls: signedUrls,
          };
        })
      );

      setStudentPayments(paymentsWithSignedUrls);
    } catch (err: any) {
      console.error('Failed to fetch student payments:', err);
      setStudentPayments([]);
    } finally {
      setStudentPaymentsLoading(false);
    }
  };

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStudentForPopup) return;

    setAddPaymentLoading(true);
    setError('');

    try {
      const amount = parseFloat(newPaymentData.amount);
      const balanceAmount = parseFloat(newPaymentData.balance_amount);

      if (isNaN(amount) || amount < 0) {
        throw new Error('Please enter a valid amount');
      }

      if (isNaN(balanceAmount) || balanceAmount < 0) {
        throw new Error('Please enter a valid balance amount');
      }

      if (!newPaymentData.payment_mode) {
        throw new Error('Please select a payment mode');
      }

      const newSubjectsStr = (newPaymentData.subjects || '').trim();
      const newSubjectSet = newSubjectsStr ? newSubjectsStr.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
      let skipInsert = false; // If we merge into existing row, skip the insert

      // Upload screenshot if provided (check for duplicate first)
      let screenshotUrl = '';
      let screenshotHash: string | null = null;
      if (addPaymentScreenshot) {
        const hash = await hashFile(addPaymentScreenshot);
        const duplicateScreenshot = await screenshotExistsInDb(hash);
        if (duplicateScreenshot) {
          setError('This screenshot has already been uploaded. Please do not upload the same image again.');
          setAddPaymentLoading(false);
          return;
        }
        screenshotHash = hash;
        const fileName = `${user!.id}/${Date.now()}_${addPaymentScreenshot.name}`;
        const { error: uploadError } = await supabase.storage
          .from('payment-screenshots')
          .upload(fileName, addPaymentScreenshot);
        if (uploadError) throw uploadError;
        const { data: { publicUrl } } = supabase.storage
          .from('payment-screenshots')
          .getPublicUrl(fileName);
        screenshotUrl = publicUrl;
        try { await supabase.rpc('record_screenshot_hash', { p_hash: hash }); } catch { /* ignore */ }
      }

      if (newSubjectSet.length > 0) {
        // Use RPC so we see/update all payments for this student (including those created by other users)
        const { data: existingPayments, error: fetchErr } = await supabase.rpc('get_student_payments_for_partial_pay', {
          p_student_id: selectedStudentForPopup.id,
        });
        if (fetchErr) throw fetchErr;
        for (const row of existingPayments || []) {
          const rowSubjectStrs = (row.subjects || '').split(',').map((s: string) => s.trim()).filter(Boolean);
          const rowSubjectSetLower = rowSubjectStrs.map((s: string) => s.toLowerCase());
          const paidInThisRow = rowSubjectSetLower.filter((rs: string) => newSubjectSet.includes(rs));
          if (paidInThisRow.length === 0) continue; // no overlap, leave row as-is
          const remainingStrs = rowSubjectStrs.filter((_s: string, i: number) => !newSubjectSet.includes(rowSubjectSetLower[i]));
          if (amount > 0) {
            // Paying: check if we should MERGE (completing a partial) or DELETE + INSERT
            const totalForSubject = amount + balanceAmount;
            if (remainingStrs.length === 0) {
              const oldBalance = Number(row.balance_amount) || 0;
              if (oldBalance > 0) {
                // Old row was a partial payment. MERGE into it: add amounts, merge screenshots, show total.
                const arr = row.payment_screenshot_urls;
                const existingUrls = (arr && Array.isArray(arr) && arr.length > 0)
                  ? arr
                  : (row.payment_screenshot_url ? [row.payment_screenshot_url] : []);
                const { data: mergeRows, error: mergeError } = await supabase.rpc('merge_student_payment_complete', {
                  p_payment_id: row.id,
                  p_add_amount: amount,
                  p_new_balance_amount: balanceAmount,
                  p_new_payment_status: newPaymentData.payment_status,
                  p_new_screenshot_url: screenshotUrl || null,
                  p_existing_screenshot_urls: existingUrls,
                });
                if (mergeError) throw mergeError;
                if (Number(Array.isArray(mergeRows) ? mergeRows[0] : mergeRows) !== 1) {
                  throw new Error('Could not complete partial payment.');
                }
                skipInsert = true; // We merged into existing row, don't insert new
              } else {
                // Old row was fully paid or unpaid with balance 0. DELETE it and insert new.
                const { data: delRows, error: delError } = await supabase.rpc('delete_student_payment_for_partial_pay', { p_payment_id: row.id });
                if (delError) throw delError;
                if (Number(Array.isArray(delRows) ? delRows[0] : delRows) !== 1) {
                  throw new Error('Could not update existing unpaid bill.');
                }
              }
            } else {
              const oldBalance = Number(row.balance_amount) || 0;
              const newBalance = Math.max(0, oldBalance - totalForSubject);
              const newStatus = newBalance === 0 ? 'paid_completely' : undefined;
              const { data: updRows, error: updateError } = await supabase.rpc('update_student_payment_for_partial_pay', {
                p_payment_id: row.id,
                p_new_subjects: remainingStrs.join(', '),
                p_new_balance_amount: newBalance,
                p_new_payment_status: newStatus ?? null,
              });
              if (updateError) throw updateError;
              if (Number(Array.isArray(updRows) ? updRows[0] : updRows) !== 1) {
                throw new Error('Could not update existing unpaid bill.');
              }
            }
          } else {
            // Unpaid entry (amount 0): replace existing row for these subjects
            if (remainingStrs.length === 0) {
              const { data: delRows, error: delError } = await supabase.rpc('delete_student_payment_for_partial_pay', { p_payment_id: row.id });
              if (delError) throw delError;
              if (Number(Array.isArray(delRows) ? delRows[0] : delRows) !== 1) {
                throw new Error('Could not update existing payment.');
              }
            } else {
              const { data: updRows, error: updateError } = await supabase.rpc('update_student_payment_for_partial_pay', {
                p_payment_id: row.id,
                p_new_subjects: remainingStrs.join(', '),
                p_new_balance_amount: Number(row.balance_amount) || 0,
                p_new_payment_status: null,
              });
              if (updateError) throw updateError;
              if (Number(Array.isArray(updRows) ? updRows[0] : updRows) !== 1) {
                throw new Error('Could not update existing payment.');
              }
            }
          }
        }
      }

      // Insert new row only if we didn't merge into an existing one
      if (!skipInsert) {
        const { error: insertError } = await supabase
          .from('student_payments')
          .insert({
            user_id: selectedStudentForPopup.user_id,
            student_id: selectedStudentForPopup.id,
            payment_mode: newPaymentData.payment_mode,
            currency: newPaymentData.currency,
            amount: amount,
            payment_status: newPaymentData.payment_status,
            balance_amount: balanceAmount,
            credited_to: newPaymentData.credited_to || null,
            payment_date: newPaymentData.payment_date || null,
            payment_screenshot_url: screenshotUrl || null,
            screenshot_hash: screenshotHash,
            subjects: newPaymentData.subjects?.trim() || null,
            payment_screenshot_urls: screenshotUrl ? [screenshotUrl] : [],
          });

        if (insertError) throw insertError;
      }

      // Refresh payment list
      await fetchStudentPayments(selectedStudentForPopup.id);

      // Reset form
      setNewPaymentData({
        payment_mode: '',
        currency: 'USD',
        amount: '',
        payment_status: 'unpaid',
        balance_amount: '',
        payment_date: '',
        credited_to: '',
        subjects: '',
      });
      setAddPaymentScreenshot(null);
      setAddPaymentScreenshotPreview('');
      setShowAddPaymentModal(false);
    } catch (err: any) {
      setError(err.message || 'Failed to add payment');
    } finally {
      setAddPaymentLoading(false);
    }
  };

  const handleEditPaymentOpen = (payment: StudentPayment) => {
    setEditingPayment(payment);
    setEditPaymentData({
      payment_mode: payment.payment_mode || '',
      currency: payment.currency || 'USD',
      amount: String(payment.amount ?? ''),
      payment_status: payment.payment_status || 'unpaid',
      balance_amount: String(payment.balance_amount ?? ''),
      payment_date: payment.payment_date ? payment.payment_date.split('T')[0] : '',
      credited_to: payment.credited_to || '',
      subjects: payment.subjects || '',
    });
    setShowEditPaymentModal(true);
  };

  const handleEditPaymentClose = () => {
    setShowEditPaymentModal(false);
    setEditingPayment(null);
    setError('');
  };

  const handleUpdatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPayment || !selectedStudentForPopup) return;

    setEditPaymentLoading(true);
    setError('');
    try {
      const amount = parseFloat(editPaymentData.amount);
      const balanceAmount = parseFloat(editPaymentData.balance_amount);
      if (isNaN(amount) || amount < 0) throw new Error('Please enter a valid amount');
      if (isNaN(balanceAmount) || balanceAmount < 0) throw new Error('Please enter a valid balance amount');
      if (!editPaymentData.payment_mode) throw new Error('Please select a payment mode');

      const { error } = await supabase
        .from('student_payments')
        .update({
          payment_mode: editPaymentData.payment_mode,
          currency: editPaymentData.currency,
          amount,
          payment_status: editPaymentData.payment_status,
          balance_amount: balanceAmount,
          payment_date: editPaymentData.payment_date || null,
          credited_to: editPaymentData.credited_to?.trim() || null,
          subjects: editPaymentData.subjects?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', editingPayment.id);

      if (error) throw error;
      await fetchStudentPayments(selectedStudentForPopup.id);
      handleEditPaymentClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update payment');
    } finally {
      setEditPaymentLoading(false);
    }
  };

  const handleDeletePayment = async (paymentId: string) => {
    if (!confirm('Are you sure you want to delete this payment record?')) {
      return;
    }

    if (!selectedStudentForPopup) return;

    try {
      const { error } = await supabase
        .from('student_payments')
        .delete()
        .eq('id', paymentId);

      if (error) throw error;

      // Refresh payment list
      await fetchStudentPayments(selectedStudentForPopup.id);
    } catch (err: any) {
      setError(err.message || 'Failed to delete payment');
      alert('Failed to delete payment: ' + err.message);
    }
  };

  const fetchExcelUploads = async () => {
    setExcelUploadsLoading(true);
    try {
      const { data, error } = await supabase
        .from('excel_uploads')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setExcelUploads(data || []);
    } catch (err: any) {
      console.error('Failed to fetch Excel uploads:', err);
      setExcelUploads([]);
    } finally {
      setExcelUploadsLoading(false);
    }
  };

  const handleViewExcel = async (upload: ExcelUpload) => {
    setSelectedExcelFile(upload);
    setExcelPreviewLoading(true);
    setExcelPreviewData([]);

    try {
      // Extract the path within the bucket (remove 'excel-uploads/' prefix if present)
      // Handle both old format (excel-uploads/user_id/file.xlsx) and new format (user_id/file.xlsx)
      let urlPath = upload.file_path;
      if (urlPath.startsWith('excel-uploads/')) {
        urlPath = urlPath.replace('excel-uploads/', '');
      }
      
      console.log('Attempting to load Excel file:', { 
        original_file_path: upload.file_path, 
        urlPath,
        file_name: upload.file_name 
      });

      // Try to get signed URL
      const { data: signedUrlData, error: urlError } = await supabase.storage
        .from('excel-uploads')
        .createSignedUrl(urlPath, 3600);

      if (urlError) {
        console.error('Error creating signed URL:', urlError);
        // If the first attempt fails, try with the original path
        if (upload.file_path !== urlPath) {
          console.log('Retrying with original path:', upload.file_path);
          const { data: retryData, error: retryError } = await supabase.storage
            .from('excel-uploads')
            .createSignedUrl(upload.file_path, 3600);
          
          if (retryError) {
            throw new Error(`File not found: ${retryError.message}`);
          }
          
          if (!retryData?.signedUrl) {
            throw new Error('Failed to get file URL');
          }
          
          const response = await fetch(retryData.signedUrl);
          if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
          }
          
          const arrayBuffer = await response.arrayBuffer();
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          
          if (workbook.SheetNames.length === 0) {
            throw new Error('Excel file has no sheets');
          }
          
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as any[];

          console.log('Excel data loaded:', { rows: jsonData.length, columns: jsonData.length > 0 ? Object.keys(jsonData[0] as any).length : 0 });
          
          if (jsonData.length === 0) {
            throw new Error('Excel file is empty');
          }

          setExcelPreviewData(jsonData);
          return;
        }
        throw urlError;
      }
      
      if (!signedUrlData?.signedUrl) {
        throw new Error('Failed to get file URL');
      }

      console.log('Fetching Excel file from:', signedUrlData.signedUrl);
      const response = await fetch(signedUrlData.signedUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      if (workbook.SheetNames.length === 0) {
        throw new Error('Excel file has no sheets');
      }
      
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as any[];

      console.log('Excel data loaded:', { rows: jsonData.length, columns: jsonData.length > 0 ? Object.keys(jsonData[0] as any).length : 0 });
      
      if (jsonData.length === 0) {
        throw new Error('Excel file is empty');
      }

      setExcelPreviewData(jsonData);
    } catch (err: any) {
      console.error('Failed to load Excel file:', err);
      alert('Failed to load Excel file: ' + (err.message || err));
      setExcelPreviewData([]);
    } finally {
      setExcelPreviewLoading(false);
    }
  };

  const handleDownloadExcel = async (upload: ExcelUpload) => {
    try {
      // Extract the path within the bucket (remove 'excel-uploads/' prefix if present)
      let urlPath = upload.file_path;
      if (urlPath.startsWith('excel-uploads/')) {
        urlPath = urlPath.replace('excel-uploads/', '');
      }

      const { data: signedUrlData, error: urlError } = await supabase.storage
        .from('excel-uploads')
        .createSignedUrl(urlPath, 3600);

      if (urlError) throw urlError;
      if (!signedUrlData?.signedUrl) throw new Error('Failed to get file URL');

      const response = await fetch(signedUrlData.signedUrl);
      if (!response.ok) throw new Error('Failed to download file');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = upload.file_name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      alert('Failed to download Excel file: ' + (err.message || err));
    }
  };

  const handleDeleteStudent = async (recordId: string) => {
    if (!confirm('Are you sure you want to delete this student record?')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('student_records')
        .delete()
        .eq('id', recordId);

      if (error) throw error;

      setStudentRecords(prevRecords =>
        prevRecords.filter(record => record.id !== recordId)
      );
    } catch (err: any) {
      console.error('Failed to delete student record:', err);
      alert('Failed to delete student record: ' + err.message);
    }
  };

  const handleToggleCritical = async (recordId: string, current: boolean) => {
    try {
      const { error } = await supabase
        .from('student_records')
        .update({ is_critical: !current })
        .eq('id', recordId);

      if (error) throw error;

      setStudentRecords(prev =>
        prev.map(r => (r.id === recordId ? { ...r, is_critical: !current } : r))
      );
    } catch (err: any) {
      console.error('Failed to update critical flag:', err);
      alert('Failed to update: ' + err.message);
    }
  };

  const handleEditStudentClick = (record: StudentRecord) => {
    setEditingStudent(record);
    setEditStudentData({
      student_name: record.student_name,
      email: record.email || '',
      password: record.password || '',
      phone_number: record.phone_number || '',
      university: record.university || '',
      subjects: record.subjects || '',
    });
    setShowEditStudentModal(true);
  };

  const handleEditStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditStudentLoading(true);

    try {
      if (!editStudentData.student_name) {
        throw new Error('Student name is required');
      }

      const formattedSubjects = editStudentData.subjects
        .split(',')
        .map(s => s.trim())
        .filter(s => s)
        .join(', ');

      const { error } = await supabase
        .from('student_records')
        .update({
          student_name: editStudentData.student_name,
          email: editStudentData.email || null,
          password: editStudentData.password || null,
          phone_number: editStudentData.phone_number || null,
          university: editStudentData.university || null,
          subjects: formattedSubjects || null,
        })
        .eq('id', editingStudent!.id);

      if (error) throw error;

      await fetchStudentRecords();

      setShowEditStudentModal(false);
      setEditingStudent(null);
      setEditStudentData({
        student_name: '',
        email: '',
        password: '',
        phone_number: '',
        university: '',
        subjects: '',
      });
    } catch (err: any) {
      console.error('Failed to update student:', err);
      alert('Failed to update student: ' + err.message);
    } finally {
      setEditStudentLoading(false);
    }
  };

  const handleDeletePaymentRecord = async (recordId: string) => {
    if (!confirm('Are you sure you want to delete this payment record? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('payment_records')
        .delete()
        .eq('id', recordId);

      if (error) throw error;

      setRecords(records.filter(r => r.id !== recordId));
    } catch (err: any) {
      alert('Failed to delete record: ' + err.message);
    }
  };

  const handleDeleteFuturePayment = async (paymentId: string) => {
    if (!confirm('Are you sure you want to delete this future payment? This action cannot be undone.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('future_payments')
        .delete()
        .eq('id', paymentId);

      if (error) throw error;

      setFuturePayments(futurePayments.filter(p => p.id !== paymentId));
    } catch (err: any) {
      alert('Failed to delete future payment: ' + err.message);
    }
  };

  const handleMarkFuturePaymentDone = async (paymentId: string) => {
    try {
      const { error } = await supabase
        .from('future_payments')
        .update({ status: 'done', updated_at: new Date().toISOString() })
        .eq('id', paymentId);

      if (error) throw error;

      setFuturePayments(futurePayments.map(p => (p.id === paymentId ? { ...p, status: 'done' } : p)));
    } catch (err: any) {
      alert('Failed to mark payment as done: ' + err.message);
    }
  };

  const handleEditFuturePayment = (payment: FuturePayment) => {
    setError('');
    setSelectedFuturePaymentForEdit(payment);
    setEditFuturePaymentData({
      sender_name: payment.sender_name || '',
      email: payment.email?.trim() || '',
      currency: payment.currency || 'USD',
      amount: String(payment.amount ?? ''),
      category: payment.category || '',
      customCategory: payment.category === 'Other' ? (payment.custom_category || '') : '',
      payment_date: payment.payment_date ? payment.payment_date.slice(0, 10) : '',
      notes: payment.notes || '',
    });
    setShowEditFuturePaymentModal(true);
  };

  const handleSaveEditFuturePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFuturePaymentForEdit) return;
    setEditFuturePaymentLoading(true);
    setError('');
    try {
      const amount = parseFloat(editFuturePaymentData.amount);
      if (isNaN(amount) || amount <= 0) {
        throw new Error('Please enter a valid amount');
      }
      if (!editFuturePaymentData.sender_name?.trim()) {
        throw new Error('Sender name is required');
      }
      if (!editFuturePaymentData.payment_date?.trim()) {
        throw new Error('Expected date is required');
      }
      const { error: updateError } = await supabase
        .from('future_payments')
        .update({
          sender_name: editFuturePaymentData.sender_name.trim(),
          email: editFuturePaymentData.email?.trim() || null,
          currency: editFuturePaymentData.currency,
          amount,
          category: editFuturePaymentData.category,
          custom_category: editFuturePaymentData.category === 'Other' ? (editFuturePaymentData.customCategory?.trim() || null) : null,
          payment_date: editFuturePaymentData.payment_date,
          notes: editFuturePaymentData.notes?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', selectedFuturePaymentForEdit.id);

      if (updateError) throw updateError;

      setFuturePayments(futurePayments.map(p =>
        p.id === selectedFuturePaymentForEdit.id
          ? {
              ...p,
              sender_name: editFuturePaymentData.sender_name.trim(),
              email: editFuturePaymentData.email?.trim() || null,
              currency: editFuturePaymentData.currency,
              amount,
              category: editFuturePaymentData.category,
              custom_category: editFuturePaymentData.category === 'Other' ? (editFuturePaymentData.customCategory?.trim() || '') : '',
              payment_date: editFuturePaymentData.payment_date,
              notes: editFuturePaymentData.notes?.trim() || '',
            }
          : p
      ));
      setShowEditFuturePaymentModal(false);
      setSelectedFuturePaymentForEdit(null);
    } catch (err: any) {
      setError(err.message || 'Failed to update future payment');
    } finally {
      setEditFuturePaymentLoading(false);
    }
  };

  const handleSubmitAddFuturePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setAddFuturePaymentLoading(true);
    setError('');
    try {
      const amount = parseFloat(addFuturePaymentData.amount);
      if (isNaN(amount) || amount <= 0) {
        throw new Error('Please enter a valid amount');
      }
      if (!addFuturePaymentData.sender_name?.trim()) {
        throw new Error('Sender name is required');
      }
      if (!addFuturePaymentData.payment_date?.trim()) {
        throw new Error('Expected date is required');
      }
      if (!addFuturePaymentData.category?.trim()) {
        throw new Error('Category is required');
      }
      const { data: inserted, error: insertError } = await supabase
        .from('future_payments')
        .insert({
          user_id: user.id,
          sender_name: addFuturePaymentData.sender_name.trim(),
          email: addFuturePaymentData.email?.trim() || null,
          currency: addFuturePaymentData.currency,
          amount,
          category: addFuturePaymentData.category,
          custom_category: addFuturePaymentData.category === 'Other' ? (addFuturePaymentData.customCategory?.trim() || null) : null,
          payment_date: addFuturePaymentData.payment_date,
          notes: addFuturePaymentData.notes?.trim() || null,
          status: 'pending',
        })
        .select('id, user_id, sender_name, email, amount, currency, category, custom_category, payment_date, notes, status, created_at')
        .single();

      if (insertError) throw insertError;
      if (inserted) {
        setFuturePayments((prev) => [inserted as FuturePayment, ...prev]);
      }
      setShowAddFuturePaymentModal(false);
      setAddFuturePaymentData({
        sender_name: '',
        email: '',
        currency: 'USD',
        amount: '',
        category: '',
        customCategory: '',
        payment_date: '',
        notes: '',
      });
    } catch (err: any) {
      setError(err.message || 'Failed to add future payment');
    } finally {
      setAddFuturePaymentLoading(false);
    }
  };

  const pendingFuturePayments = useMemo(
    () => futurePayments.filter((p) => (p.status || 'pending') !== 'done'),
    [futurePayments]
  );

  const filteredPaymentRecords = useMemo(() => {
    if (!paymentRecordsSearchQuery.trim()) {
      return records;
    }
    const query = paymentRecordsSearchQuery.toLowerCase();
    return records.filter(record =>
      record.recipient_name.toLowerCase().includes(query) ||
      record.payment_method.toLowerCase().includes(query) ||
      record.payment_currency.toLowerCase().includes(query) ||
      record.receiver_bank_holder.toLowerCase().includes(query) ||
      (record.utr_number && record.utr_number.toLowerCase().includes(query)) ||
      (record.requirements && record.requirements.toLowerCase().includes(query))
    );
  }, [records, paymentRecordsSearchQuery]);

  const filteredFuturePayments = useMemo(() => {
    if (!futurePaymentsSearchQuery.trim()) {
      return futurePayments;
    }
    const query = futurePaymentsSearchQuery.toLowerCase();
    return futurePayments.filter(payment =>
      payment.sender_name.toLowerCase().includes(query) ||
      payment.category.toLowerCase().includes(query) ||
      (payment.custom_category && payment.custom_category.toLowerCase().includes(query)) ||
      payment.currency.toLowerCase().includes(query) ||
      (payment.notes && payment.notes.toLowerCase().includes(query))
    );
  }, [futurePayments, futurePaymentsSearchQuery]);

  // Keep analytics for backward compatibility (used in other tabs)
  const analytics = useMemo(() => {
    const totalPayments = records.length;
    const byCurrency: { [key: string]: { total: number; count: number; received: number; sent: number } } = {};

    records.forEach(record => {
      const currency = record.payment_currency;
      if (!byCurrency[currency]) {
        byCurrency[currency] = { total: 0, count: 0, received: 0, sent: 0 };
      }
      byCurrency[currency].total += record.payment_amount;
      byCurrency[currency].count += 1;

      if (record.payment_type === 'Received') {
        byCurrency[currency].received += record.payment_amount;
      } else {
        byCurrency[currency].sent += record.payment_amount;
      }
    });

    return { totalPayments, byCurrency };
  }, [records]);
  console.log('Analytics:', analytics); // Keep for debugging

  // Comprehensive analytics for overview dashboard
  const comprehensiveAnalytics = useMemo(() => {
    // Student payment analytics
    const totalStudents = studentRecords.length;
    const totalStudentPayments = studentPayments.reduce((sum, p) => sum + p.amount, 0);
    const totalStudentBalance = studentPayments.reduce((sum, p) => sum + p.balance_amount, 0);
    const paidStudents = studentPayments.filter(p => p.payment_status === 'paid_completely').length;
    const unpaidStudents = studentPayments.filter(p => p.payment_status === 'unpaid').length;
    const partiallyPaidStudents = studentPayments.filter(p => p.payment_status === 'paid_partially').length;

    // Payment method distribution — only paid (partially or completely), exclude unpaid bills
    const paymentMethodDistribution: { [key: string]: number } = {};
    records.forEach(record => {
      const method = record.payment_method || 'Other';
      paymentMethodDistribution[method] = (paymentMethodDistribution[method] || 0) + 1;
    });
    studentPayments
      .filter(p => p.payment_status === 'paid_partially' || p.payment_status === 'paid_completely')
      .forEach(payment => {
        const method = payment.payment_mode || 'Other';
        paymentMethodDistribution[method] = (paymentMethodDistribution[method] || 0) + 1;
      });
    // Future payments are unpaid — exclude from payment method distribution

    // Monthly payment trends (last 12 months)
    const monthlyTrends: { [key: string]: { received: number; sent: number; count: number; receivedByCurrency: Record<string, number>; sentByCurrency: Record<string, number> } } = {};
    const last12Months = Array.from({ length: 12 }, (_, i) => {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      return date.toISOString().substring(0, 7); // YYYY-MM format
    }).reverse();

    last12Months.forEach(month => {
      monthlyTrends[month] = {
        received: 0,
        sent: 0,
        count: 0,
        receivedByCurrency: {} as Record<string, number>,
        sentByCurrency: {} as Record<string, number>,
      };
    });

    records.forEach(record => {
      const month = record.payment_date.substring(0, 7);
      const currency = record.payment_currency || 'USD';
      if (monthlyTrends[month]) {
        monthlyTrends[month].count += 1;
        if (record.payment_type === 'Received') {
          monthlyTrends[month].received += record.payment_amount;
          monthlyTrends[month].receivedByCurrency[currency] = (monthlyTrends[month].receivedByCurrency[currency] || 0) + record.payment_amount;
        } else {
          monthlyTrends[month].sent += record.payment_amount;
          monthlyTrends[month].sentByCurrency[currency] = (monthlyTrends[month].sentByCurrency[currency] || 0) + record.payment_amount;
        }
      }
    });

    // Include student payments in monthly trends (as received) — only partial or completed, exclude unpaid
    studentPayments
      .filter(p => p.payment_status === 'paid_partially' || p.payment_status === 'paid_completely')
      .forEach(payment => {
        if (!payment.payment_date) return;
        const month = payment.payment_date.substring(0, 7);
        const currency = payment.currency || 'USD';
        if (monthlyTrends[month]) {
          monthlyTrends[month].count += 1;
          monthlyTrends[month].received += payment.amount;
          monthlyTrends[month].receivedByCurrency[currency] = (monthlyTrends[month].receivedByCurrency[currency] || 0) + payment.amount;
        }
      });

    // Delayed/overdue student payments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const delayedPayments = studentPayments.filter(p => {
      if (p.payment_status === 'paid_completely') return false;
      if (!p.payment_date) return false;
      const paymentDate = new Date(p.payment_date);
      return paymentDate < today && p.balance_amount > 0;
    });

    // Payments by date (for calendar)
    const paymentsByDate: { [key: string]: { count: number; total: number; payments: any[] } } = {};
    records.forEach(record => {
      const date = record.payment_date;
      if (!paymentsByDate[date]) {
        paymentsByDate[date] = { count: 0, total: 0, payments: [] };
      }
      paymentsByDate[date].count += 1;
      paymentsByDate[date].total += record.payment_amount;
      paymentsByDate[date].payments.push(record);
    });

    studentPayments
      .filter(p => p.payment_status === 'paid_partially' || p.payment_status === 'paid_completely')
      .forEach(payment => {
        if (payment.payment_date) {
          const date = payment.payment_date;
          if (!paymentsByDate[date]) {
            paymentsByDate[date] = { count: 0, total: 0, payments: [] };
          }
          paymentsByDate[date].count += 1;
          paymentsByDate[date].total += payment.amount;
          paymentsByDate[date].payments.push(payment);
        }
      });

    // Include done future payments in monthly trends (as received) and in paymentsByDate
    const doneFuturePayments = futurePayments.filter((fp) => (fp.status || 'pending') === 'done');
    doneFuturePayments.forEach((fp) => {
      const month = fp.payment_date.substring(0, 7);
      const currency = fp.currency || 'USD';
      if (monthlyTrends[month]) {
        monthlyTrends[month].count += 1;
        monthlyTrends[month].received += fp.amount;
        monthlyTrends[month].receivedByCurrency[currency] = (monthlyTrends[month].receivedByCurrency[currency] || 0) + fp.amount;
      }
      const date = fp.payment_date;
      if (!paymentsByDate[date]) {
        paymentsByDate[date] = { count: 0, total: 0, payments: [] };
      }
      paymentsByDate[date].count += 1;
      paymentsByDate[date].total += fp.amount;
      paymentsByDate[date].payments.push({
        ...fp,
        recipient_name: fp.sender_name,
        payment_amount: fp.amount,
        payment_currency: fp.currency,
        payment_status: 'paid_completely',
      });
    });

    return {
      totalStudents,
      totalStudentPayments,
      totalStudentBalance,
      paidStudents,
      unpaidStudents,
      partiallyPaidStudents,
      paymentMethodDistribution,
      monthlyTrends,
      delayedPayments,
      paymentsByDate,
    };
  }, [records, studentRecords, studentPayments, futurePayments]);

  const delayedFuturePayments = useMemo(() => {
    const todayStr = toLocalDateStr(new Date());
    return pendingFuturePayments.filter((fp) => fp.payment_date < todayStr);
  }, [pendingFuturePayments]);

  const statusPieData = useMemo(() => {
    const todayStr = toLocalDateStr(new Date());
    const done = futurePayments.filter((fp) => (fp.status || 'pending') === 'done').length;
    const delayed = delayedFuturePayments.length + comprehensiveAnalytics.delayedPayments.length;
    const pending = pendingFuturePayments.filter((fp) => fp.payment_date >= todayStr).length;
    return [
      { name: 'Done', value: done, fill: '#10b981' },
      { name: 'Delayed', value: delayed, fill: '#ef4444' },
      { name: 'Pending', value: pending, fill: '#f59e0b' },
    ].filter((d) => d.value > 0);
  }, [futurePayments, delayedFuturePayments, comprehensiveAnalytics, pendingFuturePayments]);

  const collectedByCurrency = useMemo(() => {
    const byCur: Record<string, number> = {};
    studentPayments.forEach((p) => {
      const c = p.currency || 'USD';
      byCur[c] = (byCur[c] || 0) + p.amount;
    });
    records.filter((r) => r.payment_type === 'Received').forEach((r) => {
      const c = r.payment_currency || 'USD';
      byCur[c] = (byCur[c] || 0) + (r.payment_amount || 0);
    });
    futurePayments.filter((fp) => (fp.status || 'pending') === 'done').forEach((fp) => {
      const c = fp.currency || 'USD';
      byCur[c] = (byCur[c] || 0) + fp.amount;
    });
    return byCur;
  }, [studentPayments, records, futurePayments]);

  const pendingByCurrency = useMemo(() => {
    const byCur: Record<string, number> = {};
    studentPayments.forEach((p) => {
      const c = p.currency || 'USD';
      byCur[c] = (byCur[c] || 0) + (p.balance_amount || 0);
    });
    pendingFuturePayments.forEach((fp) => {
      const c = fp.currency || 'USD';
      byCur[c] = (byCur[c] || 0) + fp.amount;
    });
    return byCur;
  }, [studentPayments, pendingFuturePayments]);

  const futurePaymentAnalytics = useMemo(() => {
    const totalFuturePayments = pendingFuturePayments.length;
    const totalAmount = pendingFuturePayments.reduce((sum, payment) => sum + payment.amount, 0);

    const byCategory: { [key: string]: { count: number; total: number } } = {};
    pendingFuturePayments.forEach(payment => {
      if (!byCategory[payment.category]) {
        byCategory[payment.category] = { count: 0, total: 0 };
      }
      byCategory[payment.category].count += 1;
      byCategory[payment.category].total += payment.amount;
    });

    const upcomingThisWeek = pendingFuturePayments.filter(payment => {
      const paymentDate = new Date(payment.payment_date);
      const today = new Date();
      const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
      return paymentDate >= today && paymentDate <= nextWeek;
    });

    return {
      totalFuturePayments,
      totalAmount,
      byCategory,
      upcomingThisWeek: upcomingThisWeek.length,
      upcomingThisWeekAmount: upcomingThisWeek.reduce((sum, p) => sum + p.amount, 0)
    };
  }, [pendingFuturePayments]);

  // Search by credited-to name: all payments credited to a given bank holder / recipient
  const creditedToSearchResults = useMemo(() => {
    const query = creditedToSearchQuery.trim().toLowerCase();
    if (!query) {
      return { paymentRecords: [], studentPayments: [], totalAmount: 0, totalCount: 0, byCurrency: {} as { [currency: string]: number } };
    }

    const paymentRecords = records.filter(
      (r) =>
        (r.recipient_name && r.recipient_name.toLowerCase().includes(query)) ||
        (r.receiver_bank_holder && r.receiver_bank_holder.toLowerCase().includes(query))
    );

    const studentPaymentsFiltered = studentPayments.filter(
      (p) => p.credited_to && p.credited_to.toLowerCase().includes(query)
    );

    const totalFromRecords = paymentRecords.reduce((sum, r) => sum + r.payment_amount, 0);
    const totalFromStudentPayments = studentPaymentsFiltered.reduce((sum, p) => sum + p.amount, 0);
    const totalAmount = totalFromRecords + totalFromStudentPayments;
    const totalCount = paymentRecords.length + studentPaymentsFiltered.length;

    const byCurrency: { [currency: string]: number } = {};
    paymentRecords.forEach((r) => {
      const c = r.payment_currency || 'USD';
      byCurrency[c] = (byCurrency[c] || 0) + r.payment_amount;
    });
    studentPaymentsFiltered.forEach((p) => {
      const c = p.currency || 'USD';
      byCurrency[c] = (byCurrency[c] || 0) + p.amount;
    });

    return {
      paymentRecords,
      studentPayments: studentPaymentsFiltered,
      totalAmount,
      totalCount,
      byCurrency,
    };
  }, [creditedToSearchQuery, records, studentPayments]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const groupedStudents = useMemo(() => {
    const groups = new Map<string, {
      email: string;
      student_name: string;
      phone_number: string | null;
      university: string | null;
      records: StudentRecord[];
    }>();

    studentRecords.forEach(record => {
      const key = record.email || record.student_name;
      if (!groups.has(key)) {
        groups.set(key, {
          email: record.email || '',
          student_name: record.student_name,
          phone_number: record.phone_number,
          university: record.university,
          records: []
        });
      }
      groups.get(key)!.records.push(record);
    });

    return Array.from(groups.values());
  }, [studentRecords]);

  const filteredStudents = useMemo(() => {
    if (!searchQuery.trim()) {
      return groupedStudents;
    }
    const query = searchQuery.toLowerCase();
    return groupedStudents.filter(student =>
      student.student_name.toLowerCase().includes(query) ||
      student.email.toLowerCase().includes(query) ||
      student.university?.toLowerCase().includes(query) ||
      student.records.some(r => r.subjects?.toLowerCase().includes(query))
    );
  }, [groupedStudents, searchQuery]);

  // Get unique universities for filter dropdown
  const uniqueUniversities = useMemo(() => {
    const universities = new Set<string>();
    studentRecords.forEach(record => {
      if (record.university) {
        universities.add(record.university);
      }
    });
    return Array.from(universities).sort();
  }, [studentRecords]);

  // Filter students for export based on export filters
  const getFilteredStudentsForExport = () => {
    let filtered = [...studentRecords];

    // Filter by university
    if (exportFilters.university) {
      filtered = filtered.filter(record => record.university === exportFilters.university);
    }

    // Filter by date range
    if (exportFilters.startDate) {
      const startDate = new Date(exportFilters.startDate);
      filtered = filtered.filter(record => {
        const recordDate = new Date(record.created_at);
        return recordDate >= startDate;
      });
    }

    if (exportFilters.endDate) {
      const endDate = new Date(exportFilters.endDate);
      endDate.setHours(23, 59, 59, 999); // Include entire end date
      filtered = filtered.filter(record => {
        const recordDate = new Date(record.created_at);
        return recordDate <= endDate;
      });
    }

    return filtered;
  };

  // Export to Excel function
  const handleExportToExcel = async () => {
    const filteredData = getFilteredStudentsForExport();
    
    if (filteredData.length === 0) {
      setError('No student records match the selected filters');
      return;
    }

    setExporting(true);
    setError('');

    try {
      // Fetch payment history for all filtered students
      const studentIds = filteredData.map(record => record.id);
      const { data: allPayments, error: paymentsError } = await supabase
        .from('student_payments')
        .select('*')
        .in('student_id', studentIds)
        .order('created_at', { ascending: false });

      if (paymentsError) {
        console.error('Error fetching payments:', paymentsError);
      }

      // Create a map of student_id to payments
      const paymentsMap = new Map<string, StudentPayment[]>();
      (allPayments || []).forEach((payment: StudentPayment) => {
        if (!paymentsMap.has(payment.student_id)) {
          paymentsMap.set(payment.student_id, []);
        }
        paymentsMap.get(payment.student_id)!.push(payment);
      });

      // Prepare student data for Excel
      const studentData = filteredData.map(record => {
        const row: any = {
          'Student Name': record.student_name,
          'Email': record.email || '',
          'Password': record.password || '',
          'Phone Number': record.phone_number || '',
          'University': record.university || '',
          'Created At': formatDate(record.created_at),
          'Updated At': formatDate(record.updated_at),
        };

        if (exportFilters.includeSubjects) {
          row['Subjects'] = record.subjects || '';
        }

        // Add payment summary
        const payments = paymentsMap.get(record.id) || [];
        row['Total Payments'] = payments.length;
        row['Total Amount Paid'] = payments.reduce((sum, p) => sum + p.amount, 0);
        row['Total Balance'] = payments.reduce((sum, p) => sum + p.balance_amount, 0);

        return row;
      });

      // Prepare payment history and fetch screenshots for embedding
      const paymentRows: Record<string, unknown>[] = [];
      const paymentImages: { rowIndex: number; imageUrls: string[] }[] = [];

      for (let i = 0; i < (allPayments || []).length; i++) {
        const payment = allPayments![i] as StudentPayment;
        const student = filteredData.find(s => s.id === payment.student_id);
        const screenshotUrls = (payment.payment_screenshot_urls && Array.isArray(payment.payment_screenshot_urls) && payment.payment_screenshot_urls.length > 0)
          ? payment.payment_screenshot_urls
          : (payment.payment_screenshot_url ? [payment.payment_screenshot_url] : []);
        paymentRows.push({
          'Student Name': student?.student_name || '',
          'Student Email': student?.email || '',
          'Subjects': payment.subjects || '',
          'Payment Mode': payment.payment_mode,
          'Currency': payment.currency,
          'Amount': payment.amount,
          'Payment Status': payment.payment_status.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
          'Balance Amount': payment.balance_amount,
          'Payment Date': payment.payment_date ? formatDate(payment.payment_date) : '',
          'Credited To': payment.credited_to || '',
          'Screenshot URLs': screenshotUrls.join(' | '),
          'Created At': formatDate(payment.created_at),
          'Updated At': formatDate(payment.updated_at),
        });
        if (screenshotUrls.length > 0) {
          paymentImages.push({ rowIndex: i + 2, imageUrls: screenshotUrls }); // +2: header row (1) + 0-based index
        }
      }

      // Create workbook with ExcelJS (supports embedded images)
      const workbook = new ExcelJS.Workbook();

      // Student Records sheet
      const studentSheet = workbook.addWorksheet('Student Records');
      const studentHeaders = studentData.length > 0 ? Object.keys(studentData[0]) : [];
      studentSheet.addRow(studentHeaders);
      studentData.forEach((row) => studentSheet.addRow(Object.values(row)));

      // Payment History sheet with embedded screenshots
      const paymentSheet = workbook.addWorksheet('Payment History', { views: [{ state: 'frozen', ySplit: 1 }] });
      if (paymentRows.length > 0) {
        const payHeaders = Object.keys(paymentRows[0]);
        paymentSheet.addRow(payHeaders);
        paymentSheet.columns = payHeaders.map((_, i) => ({ key: payHeaders[i], width: 16 }));
        paymentRows.forEach((row) => paymentSheet.addRow(Object.values(row)));

        // Fetch and embed screenshot images (first screenshot per payment)
        const IMG_WIDTH = 120;
        const IMG_HEIGHT = 90;
        const IMG_COL = 12; // Column L

        for (const { rowIndex, imageUrls } of paymentImages) {
          const rawUrl = imageUrls[0]; // Use first screenshot per payment
          if (!rawUrl) continue;
          try {
            const fetchUrl = (await getSignedScreenshotUrl(rawUrl)) ?? rawUrl;
            const res = await fetch(fetchUrl);
            if (!res.ok) continue;
            const arrayBuffer = await res.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let j = 0; j < bytes.length; j++) {
              binary += String.fromCharCode(bytes[j]);
            }
            const base64 = btoa(binary);
            const ext = (rawUrl || '').toLowerCase().includes('.png') ? 'png' : 'jpeg';
            const imageId = workbook.addImage({
              base64: `data:image/${ext};base64,${base64}`,
              extension: ext,
            });
            const rowPos = rowIndex - 1; // 0-based row for ExcelJS
            paymentSheet.addImage(imageId, {
              tl: { col: IMG_COL, row: rowPos },
              ext: { width: IMG_WIDTH, height: IMG_HEIGHT },
            });
          } catch {
            // Skip image on fetch/add error
          }
        }
      }

      // Generate filename and trigger download
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `student_records_${timestamp}.xlsx`;
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setShowExportModal(false);
      setError('');
    } catch (err: any) {
      console.error('Export error:', err);
      setError(err.message || 'Failed to export student records');
    } finally {
      setExporting(false);
    }
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddStudentLoading(true);

    try {
      if (!newStudentData.student_name) {
        throw new Error('Student name is required');
      }

      const formattedSubjects = newStudentData.subjects
        .split(',')
        .map(s => s.trim())
        .filter(s => s)
        .join(', ');

      const { error } = await supabase
        .from('student_records')
        .insert({
          user_id: user!.id,
          student_name: newStudentData.student_name,
          email: newStudentData.email || null,
          password: newStudentData.password || null,
          phone_number: newStudentData.phone_number || null,
          university: newStudentData.university || null,
          subjects: formattedSubjects || null,
          additional_info: {},
        });

      if (error) throw error;

      await fetchStudentRecords();

      setShowAddStudentModal(false);
      setNewStudentData({
        student_name: '',
        email: '',
        password: '',
        phone_number: '',
        university: '',
        subjects: '',
      });
    } catch (err: any) {
      alert('Failed to add student: ' + err.message);
    } finally {
      setAddStudentLoading(false);
    }
  };

  const handleStudentExcelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        alert('File size must be less than 10MB');
        return;
      }
      setStudentExcelFile(file);
    }
  };

  const handleBulkStudentUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddStudentLoading(true);
    setBulkUploadSuccess(false);

    try {
      const normalizeEmail = (email: unknown): string | null => {
        if (email === null || email === undefined) return null;
        const v = String(email).trim();
        if (!v) return null;
        return v.toLowerCase();
      };

      const normalizeKeyPart = (value: unknown): string => String(value ?? '').trim().toLowerCase();

      if (!studentExcelFile) {
        throw new Error('Please select an Excel file');
      }

      const data = await studentExcelFile.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      if (jsonData.length === 0) {
        throw new Error('The Excel file is empty');
      }

      const rawStudentRecords = jsonData.map((row: any) => {
        const knownFields: any = {};
        const additionalFields: any = {};
        const subjectsMap: { [key: string]: string } = {};
        let termValue = '';

        Object.keys(row).forEach((key) => {
          const lowerKey = key.toLowerCase().trim();
          const value = row[key];

          if (lowerKey.includes('name') || lowerKey === 'student') {
            knownFields.student_name = String(value || '');
          } else if (lowerKey.includes('email') || lowerKey.includes('e-mail')) {
            knownFields.email = normalizeEmail(value);
          } else if (lowerKey.includes('password') || lowerKey.includes('pass')) {
            knownFields.password = String(value || '');
          } else if (lowerKey.includes('phone') || lowerKey.includes('mobile') || lowerKey.includes('contact')) {
            knownFields.phone_number = String(value || '');
          } else if (lowerKey.includes('university') || lowerKey.includes('college') || lowerKey.includes('institution')) {
            knownFields.university = String(value || '');
          } else if (lowerKey.includes('term')) {
            termValue = String(value || '').trim();
          } else if (lowerKey.includes('sub') || lowerKey.includes('subject') || lowerKey.includes('course')) {
            const subjectValue = String(value || '').trim();
            if (subjectValue) {
              subjectsMap[key] = subjectValue;
            }
          } else {
            additionalFields[key] = value;
          }
        });

        const sortedSubjects = Object.keys(subjectsMap).sort();
        const formattedSubjects = sortedSubjects
          .map(key => {
            const subject = subjectsMap[key];
            return termValue ? `${termValue}_${subject}` : subject;
          })
          .join(', ');

        return {
          user_id: user!.id,
          student_name: knownFields.student_name || 'N/A',
          email: knownFields.email || null,
          password: knownFields.password || null,
          phone_number: knownFields.phone_number || null,
          university: knownFields.university || null,
          subjects: formattedSubjects || null,
          additional_info: additionalFields,
        };
      });

      // Dedupe rows within the uploaded file (common source of duplicates)
      const byKey = new Map<string, any>();
      let fileDuplicatesMerged = 0;

      for (const r of rawStudentRecords) {
        const key = r.email
          ? `email:${r.email}`
          : `noemail:${normalizeKeyPart(r.student_name)}|${normalizeKeyPart(r.phone_number)}|${normalizeKeyPart(r.university)}`;

        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, r);
          continue;
        }

        fileDuplicatesMerged++;

        // Merge subjects
        const existingSubjects = String(existing.subjects || '');
        const newSubjects = String(r.subjects || '');
        const combinedSubjects = Array.from(
          new Set(
            [...existingSubjects.split(','), ...newSubjects.split(',')]
              .map((s: string) => s.trim())
              .filter((s: string) => s)
          )
        ).join(', ');
        existing.subjects = combinedSubjects || null;

        // Prefer non-empty fields from the newer row
        existing.student_name = existing.student_name || r.student_name;
        existing.password = existing.password || r.password;
        existing.phone_number = existing.phone_number || r.phone_number;
        existing.university = existing.university || r.university;

        // Merge additional info (later row wins on collisions)
        existing.additional_info = { ...(existing.additional_info || {}), ...(r.additional_info || {}) };

        byKey.set(key, existing);
      }

      const studentRecords = Array.from(byKey.values());

      // Helper function to normalize subjects (sort and normalize for comparison)
      const normalizeSubjects = (subjects: string | null): string => {
        if (!subjects) return '';
        return subjects
          .split(',')
          .map((s: string) => s.trim().toLowerCase())
          .filter((s: string) => s)
          .sort()
          .join(', ');
      };

      // Helper function to normalize and compare student records
      const normalizeRecord = (record: any) => {
        return {
          student_name: String(record.student_name || '').trim().toLowerCase(),
          email: normalizeEmail(record.email),
          password: String(record.password || '').trim(),
          phone_number: String(record.phone_number || '').trim(),
          university: String(record.university || '').trim().toLowerCase(),
          subjects: normalizeSubjects(record.subjects), // Normalize subjects for comparison
        };
      };

      // Helper function to create a fingerprint of student records for comparison
      const createRecordsFingerprint = (records: any[]): string => {
        const normalized = records.map(r => {
          const normalized = normalizeRecord(r);
          return `${normalized.student_name}|${normalized.email || ''}|${normalized.phone_number}|${normalized.university}|${normalized.subjects}`;
        }).sort().join('||');
        return normalized;
      };

      // Condition 3: Check if this Excel data was uploaded before
      const currentFingerprint = createRecordsFingerprint(studentRecords);
      
      // Fetch all previous Excel uploads for this user
      const { data: previousUploads, error: uploadsError } = await supabase
        .from('excel_uploads')
        .select('file_path, upload_type')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false });

      if (!uploadsError && previousUploads && previousUploads.length > 0) {
        // Check each previous upload to see if data matches
        for (const prevUpload of previousUploads) {
          try {
            // Download and parse the previous Excel file
            const urlPath = prevUpload.file_path.replace('excel-uploads/', '');
            const { data: signedUrlData } = await supabase.storage
              .from('excel-uploads')
              .createSignedUrl(urlPath, 60);

            if (signedUrlData?.signedUrl) {
              const response = await fetch(signedUrlData.signedUrl);
              const arrayBuffer = await response.arrayBuffer();
              const prevWorkbook = XLSX.read(arrayBuffer, { type: 'array' });
              const prevSheetName = prevWorkbook.SheetNames[0];
              const prevWorksheet = prevWorkbook.Sheets[prevSheetName];
              const prevJsonData = XLSX.utils.sheet_to_json(prevWorksheet) as any[];

              if (prevJsonData.length > 0) {
                // Process previous Excel the same way
                const prevRawRecords = prevJsonData.map((row: any) => {
                  const knownFields: any = {};
                  const additionalFields: any = {};
                  const subjectsMap: { [key: string]: string } = {};
                  let termValue = '';

                  Object.keys(row).forEach((key) => {
                    const lowerKey = key.toLowerCase().trim();
                    const value = row[key];

                    if (lowerKey.includes('name') || lowerKey === 'student') {
                      knownFields.student_name = String(value || '');
                    } else if (lowerKey.includes('email') || lowerKey.includes('e-mail')) {
                      knownFields.email = normalizeEmail(value);
                    } else if (lowerKey.includes('password') || lowerKey.includes('pass')) {
                      knownFields.password = String(value || '');
                    } else if (lowerKey.includes('phone') || lowerKey.includes('mobile') || lowerKey.includes('contact')) {
                      knownFields.phone_number = String(value || '');
                    } else if (lowerKey.includes('university') || lowerKey.includes('college') || lowerKey.includes('institution')) {
                      knownFields.university = String(value || '');
                    } else if (lowerKey.includes('term')) {
                      termValue = String(value || '').trim();
                    } else if (lowerKey.includes('sub') || lowerKey.includes('subject') || lowerKey.includes('course')) {
                      const subjectValue = String(value || '').trim();
                      if (subjectValue) {
                        subjectsMap[key] = subjectValue;
                      }
                    } else {
                      additionalFields[key] = value;
                    }
                  });

                  const sortedSubjects = Object.keys(subjectsMap).sort();
                  const formattedSubjects = sortedSubjects
                    .map(key => {
                      const subject = subjectsMap[key];
                      return termValue ? `${termValue}_${subject}` : subject;
                    })
                    .join(', ');

                  return {
                    user_id: user!.id,
                    student_name: knownFields.student_name || 'N/A',
                    email: knownFields.email || null,
                    password: knownFields.password || null,
                    phone_number: knownFields.phone_number || null,
                    university: knownFields.university || null,
                    subjects: formattedSubjects || null,
                    additional_info: additionalFields,
                  };
                });

                // Dedupe previous Excel the same way
                const prevByKey = new Map<string, any>();
                for (const r of prevRawRecords) {
                  const key = r.email
                    ? `email:${r.email}`
                    : `noemail:${normalizeKeyPart(r.student_name)}|${normalizeKeyPart(r.phone_number)}|${normalizeKeyPart(r.university)}`;
                  const existing = prevByKey.get(key);
                  if (!existing) {
                    prevByKey.set(key, r);
                    continue;
                  }
                  const existingSubjects = String(existing.subjects || '');
                  const newSubjects = String(r.subjects || '');
                  const combinedSubjects = Array.from(
                    new Set(
                      [...existingSubjects.split(','), ...newSubjects.split(',')]
                        .map((s: string) => s.trim())
                        .filter((s: string) => s)
                    )
                  ).join(', ');
                  existing.subjects = combinedSubjects || null;
                  prevByKey.set(key, existing);
                }

                const prevStudentRecords = Array.from(prevByKey.values());
                const prevFingerprint = createRecordsFingerprint(prevStudentRecords);

                // Compare fingerprints
                if (currentFingerprint === prevFingerprint) {
                  throw new Error('This Excel file contains data that was already uploaded before. Please upload a file with new data.');
                }
              }
            }
          } catch (err) {
            // If we can't parse a previous file, continue checking others
            console.warn('Could not check previous upload:', err);
            continue;
          }
        }
      }

      // Query ALL existing records in the database (to check for duplicates)
      // Admin should check against ALL records, not just their own, to prevent duplicates
      const { data: allExistingRecords, error: fetchError } = await supabase
        .from('student_records')
        .select('*');

      if (fetchError) throw fetchError;
      const existingRecords = allExistingRecords || [];

      // Build a map of existing records by normalized email
      const existingByEmail = new Map<string, any[]>();
      for (const record of existingRecords) {
        const em = normalizeEmail(record.email);
        if (em) {
          if (!existingByEmail.has(em)) {
            existingByEmail.set(em, []);
          }
          existingByEmail.get(em)!.push(record);
        }
      }

      // Build a map for records without email (by name+phone+university)
      const existingByKey = new Map<string, any[]>();
      for (const record of existingRecords) {
        if (!record.email || !normalizeEmail(record.email)) {
          const key = `noemail:${String(record.student_name || '').trim().toLowerCase()}|${String(record.phone_number || '').trim()}|${String(record.university || '').trim().toLowerCase()}`;
          if (!existingByKey.has(key)) {
            existingByKey.set(key, []);
          }
          existingByKey.get(key)!.push(record);
        }
      }

      const recordsToInsert: any[] = [];
      const recordsToUpdate: any[] = [];
      let skippedCount = 0;

      // First pass: Check each student in Excel to see if they have new data
      for (const newRecord of studentRecords) {
        const normalizedNew = normalizeRecord(newRecord);
        let hasNewData = false;
        let matchingExisting: any = null;

        if (!newRecord.email || !normalizeEmail(newRecord.email)) {
          // For records without email, check by name+phone+university
          const key = `noemail:${normalizedNew.student_name}|${normalizedNew.phone_number}|${normalizedNew.university}`;
          const candidates = existingByKey.get(key) || [];

          // Check if this exact student with same subjects already exists
          for (const existing of candidates) {
            const normalizedExisting = normalizeRecord(existing);
            if (
              normalizedExisting.student_name === normalizedNew.student_name &&
              normalizedExisting.phone_number === normalizedNew.phone_number &&
              normalizedExisting.university === normalizedNew.university &&
              normalizedExisting.subjects === normalizedNew.subjects
            ) {
              // Exact duplicate - no new data
              hasNewData = false;
              matchingExisting = null;
              break;
            } else if (
              normalizedExisting.student_name === normalizedNew.student_name &&
              normalizedExisting.phone_number === normalizedNew.phone_number &&
              normalizedExisting.university === normalizedNew.university
            ) {
              // Same student exists - check if subjects are different
              matchingExisting = existing;
              const existingSubjectsNormalized = normalizeSubjects(existing.subjects);
              const newSubjectsNormalized = normalizedNew.subjects;

              if (existingSubjectsNormalized !== newSubjectsNormalized) {
                // Check if new subjects are already included
                const existingSubjectsArray = existingSubjectsNormalized
                  .split(', ')
                  .filter((s: string) => s);
                const newSubjectsArray = newSubjectsNormalized
                  .split(', ')
                  .filter((s: string) => s);

                const allNewSubjectsExist = newSubjectsArray.every((newSub: string) =>
                  existingSubjectsArray.includes(newSub)
                );

                if (!allNewSubjectsExist) {
                  // Has new subjects - has new data
                  hasNewData = true;
                }
              }
              break;
            }
          }

          // If no matching student found, it's a new student
          if (!matchingExisting) {
            hasNewData = true;
          }
        } else {
          // For records with email, check all records with same email
          const normalizedEmail = normalizeEmail(newRecord.email)!;
          const candidates = existingByEmail.get(normalizedEmail) || [];

          // Find matching student record (same email, name, phone, university)
          for (const existing of candidates) {
            const normalizedExisting = normalizeRecord(existing);
            if (
              normalizedExisting.student_name === normalizedNew.student_name &&
              normalizedExisting.phone_number === normalizedNew.phone_number &&
              normalizedExisting.university === normalizedNew.university
            ) {
              matchingExisting = existing;
              break;
            }
          }

          if (matchingExisting) {
            // Same student exists - check if subjects are different
            const existingSubjectsNormalized = normalizeSubjects(matchingExisting.subjects);
            const newSubjectsNormalized = normalizedNew.subjects;

            if (existingSubjectsNormalized === newSubjectsNormalized) {
              // All subjects are the same - no new data
              hasNewData = false;
            } else {
              // Check if new subjects are already included
              const existingSubjectsArray = existingSubjectsNormalized
                .split(', ')
                .filter((s: string) => s);
              const newSubjectsArray = newSubjectsNormalized
                .split(', ')
                .filter((s: string) => s);

              const allNewSubjectsExist = newSubjectsArray.every((newSub: string) =>
                existingSubjectsArray.includes(newSub)
              );

              if (!allNewSubjectsExist) {
                // Has new subjects - has new data
                hasNewData = true;
              }
            }
          } else {
            // New student - has new data
            hasNewData = true;
          }
        }

        // Only process if this student has new data
        if (!hasNewData) {
          skippedCount++;
          continue;
        }

        // Process student with new data
        if (matchingExisting) {
          // Update existing student with new subjects
          const existingSubjectsNormalized = normalizeSubjects(matchingExisting.subjects);
          const newSubjectsNormalized = normalizedNew.subjects;
          const existingSubjectsArray = existingSubjectsNormalized
            .split(', ')
            .filter((s: string) => s);
          const newSubjectsArray = newSubjectsNormalized
            .split(', ')
            .filter((s: string) => s);

          // Merge subjects (add new ones only)
          const combinedSubjects = Array.from(
            new Set([...existingSubjectsArray, ...newSubjectsArray])
          )
            .sort()
            .join(', ');

          // Check if this record is already scheduled for update (in case of multiple rows for same student)
          const existingUpdate = recordsToUpdate.find((r) => r.id === matchingExisting.id);
          if (existingUpdate) {
            // Update the existing update with merged subjects (merge again to include all new subjects)
            const existingUpdateSubjects = normalizeSubjects(existingUpdate.subjects)
              .split(', ')
              .filter((s: string) => s);
            const allCombined = Array.from(
              new Set([...existingUpdateSubjects, ...newSubjectsArray])
            )
              .sort()
              .join(', ');
            existingUpdate.subjects = allCombined;
          } else {
            // Schedule update for this existing student (only subjects will be updated)
            recordsToUpdate.push({
              id: matchingExisting.id,
              subjects: combinedSubjects,
            });
          }
        } else {
          // New student - add it
          recordsToInsert.push(newRecord);
        }
      }

      // If no new data at all, skip the entire upload
      if (recordsToInsert.length === 0 && recordsToUpdate.length === 0) {
        throw new Error('This Excel file contains no new data. All students and their data already exist in the database.');
      }

      // Save Excel file to storage
      const fileName = `${user!.id}/${Date.now()}_${studentExcelFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from('excel-uploads')
        .upload(fileName, studentExcelFile);

      if (uploadError) throw uploadError;

      // Record metadata in excel_uploads table
      // Store just the path within the bucket (without 'excel-uploads/' prefix)
      const { error: recordError } = await supabase
        .from('excel_uploads')
        .insert({
          user_id: user!.id,
          file_name: studentExcelFile.name,
          file_path: fileName, // Store just the path within bucket: user_id/timestamp_filename.xlsx
          file_size: studentExcelFile.size,
          upload_type: 'admin',
          records_count: recordsToInsert.length + recordsToUpdate.length,
        });

      if (recordError) {
        console.error('Failed to record Excel upload metadata:', recordError);
        // Don't throw - file is already uploaded, just log the error
      }

      if (recordsToInsert.length > 0) {
        const { error: insertError } = await supabase
          .from('student_records')
          .insert(recordsToInsert);

        if (insertError) throw insertError;
      }

      if (recordsToUpdate.length > 0) {
        for (const record of recordsToUpdate) {
          const { error: updateError } = await supabase
            .from('student_records')
            .update({ subjects: record.subjects })
            .eq('id', record.id);

          if (updateError) throw updateError;
        }
      }

      setUploadedRecordsCount(recordsToInsert.length);
      setBulkUploadSuccess(true);
      await fetchStudentRecords();
      await fetchExcelUploads();

      const statusMessages = [];
      if (recordsToInsert.length > 0) {
        statusMessages.push(`${recordsToInsert.length} new records added`);
      }
      if (recordsToUpdate.length > 0) {
        statusMessages.push(`${recordsToUpdate.length} records updated with new subjects`);
      }
      if (skippedCount > 0) {
        statusMessages.push(`${skippedCount} duplicates skipped`);
      }
      if (fileDuplicatesMerged > 0) {
        statusMessages.push(`${fileDuplicatesMerged} duplicate row(s) merged from the uploaded file`);
      }

      const successMessage = statusMessages.join(', ');
      alert(successMessage || 'Upload completed successfully');

      setTimeout(() => {
        setShowAddStudentModal(false);
        setStudentExcelFile(null);
        setAddStudentMode('manual');
        setBulkUploadSuccess(false);
        setUploadedRecordsCount(0);
      }, 2000);
    } catch (err: any) {
      alert('Failed to upload students: ' + err.message);
    } finally {
      setAddStudentLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-red-900 to-slate-900">
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFmMmQ0ZCIgc3Ryb2tlLXdpZHRoPSIxIi8+PC9wYXR0ZXJuPjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyaWQpIi8+PC9zdmc+')] opacity-20"></div>

      <nav className="relative backdrop-blur-xl bg-slate-900/80 border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-red-500 to-orange-500 rounded-lg shadow-lg shadow-red-500/50">
                <Shield className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Admin Dashboard</h1>
                <p className="text-sm text-slate-300">{user?.email}</p>
              </div>
            </div>
            <button
              onClick={() => signOut()}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'overview'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <BarChart3 className="w-4 h-4 inline mr-2" />
              Overview
            </button>
            <button
              onClick={() => setActiveTab('payments')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'payments'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <CreditCard className="w-4 h-4 inline mr-2" />
              Payment Records
            </button>
            <button
              onClick={() => setActiveTab('future')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'future'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <Clock className="w-4 h-4 inline mr-2" />
              Future Repayments
            </button>
            <button
              onClick={() => setActiveTab('students')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'students'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <GraduationCap className="w-4 h-4 inline mr-2" />
              Student Records
            </button>
            <button
              onClick={() => setActiveTab('excelUploads')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'excelUploads'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 inline mr-2" />
              Excel Uploads
            </button>
            <button
              onClick={() => setActiveTab('timeSpent')}
              className={`px-6 py-3 text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === 'timeSpent'
                  ? 'text-white bg-slate-800/50 border-b-2 border-cyan-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
              }`}
            >
              <Timer className="w-4 h-4 inline mr-2" />
              Time Spent
            </button>
          </div>
        </div>
      </nav>

      <main className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Welcome Header */}
            <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-white mb-2">Hello, Admin! Here's your business overview</h2>
                  <p className="text-slate-300">Track payments, students, and analytics at a glance</p>
                </div>
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-3 relative">
                    <div className="flex items-center rounded-lg bg-cyan-500/20 border border-cyan-500/40 overflow-hidden">
                      <button
                        type="button"
                        onClick={async () => {
                          setReminderMessage('');
                          setReminderSending(true);
                          setShowReminderDropdown(false);
                          try {
                            const { data: { session } } = await supabase.auth.getSession();
                            if (!session?.access_token) {
                              setReminderMessage('Not signed in');
                              setReminderSending(false);
                              return;
                            }
                            if (!isReminderApiConfigured()) {
                              setReminderMessage('Reminder server not configured (set VITE_REMINDER_API_URL)');
                              setReminderSending(false);
                              return;
                            }
                            const res = await fetch(REMINDER_API_URLS.sendReminders, {
                              method: 'POST',
                              headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                              body: JSON.stringify({ type: 'all' }),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok) {
                              setReminderMessage(data?.error || 'Failed to send reminders');
                            } else {
                              setReminderMessage(`Sent: ${data.sent ?? 0}, Failed: ${data.failed ?? 0}`);
                            }
                          } catch (e) {
                            const msg = e instanceof Error ? e.message : 'Request failed';
                            setReminderMessage(isReminderFetchNetworkError(e) ? reminderApiNetworkErrorHint() : msg);
                          } finally {
                            setReminderSending(false);
                          }
                        }}
                        disabled={reminderSending}
                        className="inline-flex items-center gap-2 px-3 py-2 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {reminderSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                        {reminderSending ? 'Sending…' : 'Send reminder emails'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowReminderDropdown((v) => !v)}
                        disabled={reminderSending}
                        className="px-2 py-2 border-l border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 transition-colors"
                        aria-label="Choose reminder type"
                      >
                        <ChevronDown className={`w-4 h-4 transition-transform ${showReminderDropdown ? 'rotate-180' : ''}`} />
                      </button>
                    </div>
                    {showReminderDropdown && (
                      <>
                        <div className="fixed inset-0 z-[90]" aria-hidden onClick={() => setShowReminderDropdown(false)} />
                        <div className="absolute left-0 bottom-full mb-1 z-[100] min-w-[220px] py-1 rounded-lg bg-slate-800 border border-slate-600 shadow-2xl ring-2 ring-slate-700/50">
                          <button
                            type="button"
                            onClick={async () => {
                              setReminderMessage('');
                              setReminderSending(true);
                              setShowReminderDropdown(false);
                              try {
                                const { data: { session } } = await supabase.auth.getSession();
                                if (!session?.access_token) {
                                  setReminderMessage('Not signed in');
                                  setReminderSending(false);
                                  return;
                                }
                                if (!isReminderApiConfigured()) {
                                  setReminderMessage('Reminder server not configured (set VITE_REMINDER_API_URL)');
                                  setReminderSending(false);
                                  return;
                                }
                                const res = await fetch(REMINDER_API_URLS.sendReminders, {
                                  method: 'POST',
                                  headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ type: 'students' }),
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) setReminderMessage(data?.error || 'Failed');
                                else setReminderMessage(`Students: Sent ${data.sent ?? 0}, Failed ${data.failed ?? 0}`);
                              } catch (e) {
                                const msg = e instanceof Error ? e.message : 'Request failed';
                                setReminderMessage(isReminderFetchNetworkError(e) ? reminderApiNetworkErrorHint() : msg);
                              } finally {
                                setReminderSending(false);
                              }
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700/80 rounded-none last:rounded-b-lg first:rounded-t-lg"
                          >
                            Students only
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setReminderMessage('');
                              setReminderSending(true);
                              setShowReminderDropdown(false);
                              try {
                                const { data: { session } } = await supabase.auth.getSession();
                                if (!session?.access_token) {
                                  setReminderMessage('Not signed in');
                                  setReminderSending(false);
                                  return;
                                }
                                if (!isReminderApiConfigured()) {
                                  setReminderMessage('Reminder server not configured (set VITE_REMINDER_API_URL)');
                                  setReminderSending(false);
                                  return;
                                }
                                const res = await fetch(REMINDER_API_URLS.sendReminders, {
                                  method: 'POST',
                                  headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ type: 'future' }),
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) setReminderMessage(data?.error || 'Failed');
                                else setReminderMessage(`Future repayments: Sent ${data.sent ?? 0}, Failed ${data.failed ?? 0}`);
                              } catch (e) {
                                const msg = e instanceof Error ? e.message : 'Request failed';
                                setReminderMessage(isReminderFetchNetworkError(e) ? reminderApiNetworkErrorHint() : msg);
                              } finally {
                                setReminderSending(false);
                              }
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700/80 rounded-none"
                          >
                            Future repayments only
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setReminderMessage('');
                              setReminderSending(true);
                              setShowReminderDropdown(false);
                              try {
                                const { data: { session } } = await supabase.auth.getSession();
                                if (!session?.access_token) {
                                  setReminderMessage('Not signed in');
                                  setReminderSending(false);
                                  return;
                                }
                                if (!isReminderApiConfigured()) {
                                  setReminderMessage('Reminder server not configured (set VITE_REMINDER_API_URL)');
                                  setReminderSending(false);
                                  return;
                                }
                                const res = await fetch(REMINDER_API_URLS.sendReminders, {
                                  method: 'POST',
                                  headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ type: 'all' }),
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) setReminderMessage(data?.error || 'Failed');
                                else setReminderMessage(`All: Sent ${data.sent ?? 0}, Failed ${data.failed ?? 0}`);
                              } catch (e) {
                                const msg = e instanceof Error ? e.message : 'Request failed';
                                setReminderMessage(isReminderFetchNetworkError(e) ? reminderApiNetworkErrorHint() : msg);
                              } finally {
                                setReminderSending(false);
                              }
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700/80 rounded-none last:rounded-b-lg"
                          >
                            All reminders
                          </button>
                        </div>
                      </>
                    )}
                    {reminderMessage && (
                      <span className="text-sm text-slate-300">{reminderMessage}</span>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-slate-400">Last updated</p>
                    <p className="text-white font-medium">{new Date().toLocaleDateString()}</p>
                  </div>
                </div>
              </div>
            </div>

            {loading || studentRecordsLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
              </div>
            ) : (
              <>
                {/* KPI Cards with dropdown details */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
                  {/* Total Students */}
                  <div className="backdrop-blur-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 rounded-xl overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'total_students' ? null : 'total_students')} className="w-full text-left p-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="p-3 bg-blue-500/20 rounded-lg">
                          <Users className="w-6 h-6 text-blue-400" />
                        </div>
                        <span className="text-blue-400">{overviewExpandedCard === 'total_students' ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}</span>
                      </div>
                      <p className="text-sm text-slate-300 mb-1">Total Students</p>
                      <p className="text-3xl font-bold text-white">{comprehensiveAnalytics.totalStudents.toLocaleString()}</p>
                    </button>
                  </div>

                  {/* Total Collected */}
                  <div className="backdrop-blur-xl bg-gradient-to-br from-emerald-500/20 to-green-500/20 border border-emerald-500/30 rounded-xl overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'total_collected' ? null : 'total_collected')} className="w-full text-left p-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="p-3 bg-emerald-500/20 rounded-lg">
                          <DollarSign className="w-6 h-6 text-emerald-400" />
                        </div>
                        <span className="text-emerald-400">{overviewExpandedCard === 'total_collected' ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}</span>
                      </div>
                      <p className="text-sm text-slate-300 mb-1">Total Collected</p>
                      <p className="text-lg font-bold text-white leading-tight">
                        {['INR', 'USD'].map((cur) => `${cur}: ${formatCurrency(collectedByCurrency[cur] ?? 0, cur)}`).join(' • ')}
                      </p>
                    </button>
                  </div>

                  {/* Pending Balance */}
                  <div className="backdrop-blur-xl bg-gradient-to-br from-orange-500/20 to-red-500/20 border border-orange-500/30 rounded-xl overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'pending_balance' ? null : 'pending_balance')} className="w-full text-left p-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="p-3 bg-orange-500/20 rounded-lg">
                          <Wallet className="w-6 h-6 text-orange-400" />
                        </div>
                        <span className="text-orange-400">{overviewExpandedCard === 'pending_balance' ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}</span>
                      </div>
                      <p className="text-sm text-slate-300 mb-1">Pending Balance</p>
                      <p className="text-lg font-bold text-white leading-tight">
                        {['INR', 'USD'].map((cur) => `${cur}: ${formatCurrency(pendingByCurrency[cur] ?? 0, cur)}`).join(' • ')}
                      </p>
                    </button>
                  </div>

                  {/* Delayed Payments */}
                  <div className="backdrop-blur-xl bg-gradient-to-br from-red-500/20 to-pink-500/20 border border-red-500/30 rounded-xl overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'delayed' ? null : 'delayed')} className="w-full text-left p-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="p-3 bg-red-500/20 rounded-lg">
                          <Clock className="w-6 h-6 text-red-400" />
                        </div>
                        <span className="text-red-400">{overviewExpandedCard === 'delayed' ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}</span>
                      </div>
                      <p className="text-sm text-slate-300 mb-1">Delayed Payments</p>
                      <p className="text-3xl font-bold text-white">
                        {comprehensiveAnalytics.delayedPayments.length + delayedFuturePayments.length}
                      </p>
                      <p className="text-xs text-red-300 mt-2">
                        {comprehensiveAnalytics.delayedPayments.length + delayedFuturePayments.length > 0
                          ? `${comprehensiveAnalytics.delayedPayments.length} student, ${delayedFuturePayments.length} future overdue`
                          : '₹0 overdue'}
                      </p>
                    </button>
                  </div>
                </div>

                {/* Payment Status Distribution with dropdown details */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
                  {/* Paid Students */}
                  <div className="backdrop-blur-xl bg-white/10 rounded-xl shadow-xl border border-white/20 overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'paid' ? null : 'paid')} className="w-full text-left p-4 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-400">Paid Students</p>
                        <p className="text-2xl font-bold text-green-400">{comprehensiveAnalytics.paidStudents}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="p-3 bg-green-500/20 rounded-lg">
                          <Check className="w-6 h-6 text-green-400" />
                        </div>
                        <span className="text-slate-400">{overviewExpandedCard === 'paid' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
                      </div>
                    </button>
                  </div>
                  {/* Partially Paid */}
                  <div className="backdrop-blur-xl bg-white/10 rounded-xl shadow-xl border border-white/20 overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'partial' ? null : 'partial')} className="w-full text-left p-4 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-400">Partially Paid</p>
                        <p className="text-2xl font-bold text-yellow-400">{comprehensiveAnalytics.partiallyPaidStudents}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="p-3 bg-yellow-500/20 rounded-lg">
                          <Clock className="w-6 h-6 text-yellow-400" />
                        </div>
                        <span className="text-slate-400">{overviewExpandedCard === 'partial' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
                      </div>
                    </button>
                  </div>
                  {/* Unpaid Students */}
                  <div className="backdrop-blur-xl bg-white/10 rounded-xl shadow-xl border border-white/20 overflow-hidden min-w-0">
                    <button type="button" onClick={() => setOverviewExpandedCard(overviewExpandedCard === 'unpaid' ? null : 'unpaid')} className="w-full text-left p-4 flex items-center justify-between">
                      <div>
                        <p className="text-sm text-slate-400">Unpaid Students</p>
                        <p className="text-2xl font-bold text-red-400">{comprehensiveAnalytics.unpaidStudents}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="p-3 bg-red-500/20 rounded-lg">
                          <X className="w-6 h-6 text-red-400" />
                        </div>
                        <span className="text-slate-400">{overviewExpandedCard === 'unpaid' ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Full-size details panel (below all 7 cards) */}
                {overviewExpandedCard && (
                  <div className="w-full backdrop-blur-xl bg-slate-800/95 border border-white/20 rounded-2xl overflow-hidden shadow-2xl min-h-[420px] max-h-[70vh] flex flex-col">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-white/20 bg-slate-900/80 shrink-0">
                      <h3 className="text-lg font-bold text-white">
                        {overviewExpandedCard === 'total_students' && 'Total Students'}
                        {overviewExpandedCard === 'total_collected' && 'Total Collected'}
                        {overviewExpandedCard === 'pending_balance' && 'Pending Balance'}
                        {overviewExpandedCard === 'delayed' && 'Delayed Payments'}
                        {overviewExpandedCard === 'paid' && 'Paid Students'}
                        {overviewExpandedCard === 'partial' && 'Partially Paid'}
                        {overviewExpandedCard === 'unpaid' && 'Unpaid Students'}
                      </h3>
                      <button type="button" onClick={() => setOverviewExpandedCard(null)} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" aria-label="Close">
                        <ChevronUp className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto min-h-0">
                      {overviewExpandedCard === 'total_students' && (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                            <tr><th className="text-left py-3 px-4">Name</th><th className="text-left py-3 px-4">Email</th><th className="text-left py-3 px-4">University</th></tr>
                          </thead>
                          <tbody>
                            {studentRecords.length === 0 ? (
                              <tr><td colSpan={3} className="py-8 px-4 text-slate-400 text-center">No students</td></tr>
                            ) : studentRecords.map((s) => (
                              <tr key={s.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                <td className="py-3 px-4 text-white">{s.student_name}</td>
                                <td className="py-3 px-4 text-slate-300">{s.email || '—'}</td>
                                <td className="py-3 px-4 text-slate-300">{s.university || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {overviewExpandedCard === 'total_collected' && (
                        <div className="flex flex-col h-full">
                          {/* Filters for Total Collected */}
                          <div className="shrink-0 px-6 py-4 border-b border-slate-700/50 bg-slate-800/80 flex flex-wrap items-center gap-3">
                            <span className="text-sm font-medium text-slate-400">Filters:</span>
                            <input
                              type="date"
                              value={collectedFilter.dateFrom}
                              onChange={(e) => setCollectedFilter((f) => ({ ...f, dateFrom: e.target.value }))}
                              className="px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                              placeholder="From"
                            />
                            <input
                              type="date"
                              value={collectedFilter.dateTo}
                              onChange={(e) => setCollectedFilter((f) => ({ ...f, dateTo: e.target.value }))}
                              className="px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                              placeholder="To"
                            />
                            <select
                              value={collectedFilter.currency}
                              onChange={(e) => setCollectedFilter((f) => ({ ...f, currency: e.target.value }))}
                              className="px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                            >
                              <option value="all">All currencies</option>
                              {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                            <select
                              value={collectedFilter.type}
                              onChange={(e) => setCollectedFilter((f) => ({ ...f, type: e.target.value }))}
                              className="px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                            >
                              <option value="all">All types</option>
                              <option value="Student Payment">Student Payment</option>
                              <option value="Payment Record">Payment Record</option>
                              <option value="Future (done)">Future (done)</option>
                            </select>
                            <select
                              value={collectedFilter.paymentMethod}
                              onChange={(e) => setCollectedFilter((f) => ({ ...f, paymentMethod: e.target.value }))}
                              className="px-3 py-2 bg-slate-700/50 border border-slate-600 rounded-lg text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                            >
                              <option value="all">All methods</option>
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => setCollectedFilter({ dateFrom: '', dateTo: '', currency: 'all', type: 'all', paymentMethod: 'all' })}
                              className="px-3 py-2 bg-slate-600/50 hover:bg-slate-600 text-slate-300 rounded-lg text-sm"
                            >
                              Clear
                            </button>
                          </div>
                          <div className="flex-1 overflow-auto min-h-0">
                            <table className="w-full text-sm">
                              <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                                <tr>
                                  <th className="text-left py-3 px-4">Type</th>
                                  <th className="text-left py-3 px-4">Student / Recipient</th>
                                  <th className="text-left py-3 px-4">Amount</th>
                                  <th className="text-left py-3 px-4">Currency</th>
                                  <th className="text-left py-3 px-4">Date</th>
                                  <th className="text-left py-3 px-4">Method</th>
                                  <th className="text-left py-3 px-4">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(() => {
                                  const studentRows = studentPayments.map((p) => {
                                    const student = studentRecords.find((s) => s.id === p.student_id);
                                    return { type: 'Student Payment' as const, name: student?.student_name || '—', amount: p.amount, currency: p.currency, date: p.payment_date, paymentMethod: p.payment_mode || '—', status: p.payment_status?.replace('_', ' ') || '—', id: `sp-${p.id}` };
                                  });
                                  const recordRows = records.filter((r) => r.payment_type === 'Received').map((r) => ({
                                    type: 'Payment Record' as const,
                                    name: r.recipient_name || r.receiver_bank_holder || '—',
                                    amount: r.payment_amount || 0,
                                    currency: r.payment_currency || 'USD',
                                    date: r.payment_date,
                                    paymentMethod: r.payment_method || '—',
                                    status: 'Received',
                                    id: `pr-${r.id}`,
                                  }));
                                  const doneFutureRows = futurePayments.filter((fp) => (fp.status || 'pending') === 'done').map((fp) => ({
                                    type: 'Future (done)' as const,
                                    name: fp.sender_name,
                                    amount: fp.amount,
                                    currency: fp.currency || 'USD',
                                    date: fp.payment_date,
                                    paymentMethod: '—',
                                    status: 'Done',
                                    id: `fp-${fp.id}`,
                                  }));
                                  let combined = [...studentRows, ...recordRows, ...doneFutureRows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
                                  if (collectedFilter.dateFrom) combined = combined.filter((r) => r.date && r.date >= collectedFilter.dateFrom);
                                  if (collectedFilter.dateTo) combined = combined.filter((r) => r.date && r.date <= collectedFilter.dateTo);
                                  if (collectedFilter.currency !== 'all') combined = combined.filter((r) => r.currency === collectedFilter.currency);
                                  if (collectedFilter.type !== 'all') combined = combined.filter((r) => r.type === collectedFilter.type);
                                  if (collectedFilter.paymentMethod !== 'all') combined = combined.filter((r) => r.paymentMethod === collectedFilter.paymentMethod);
                                  if (combined.length === 0) return <tr><td colSpan={7} className="py-8 px-4 text-slate-400 text-center">No collected payments match the filters</td></tr>;
                                  return combined.map((row) => (
                                    <tr key={row.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                      <td className="py-3 px-4"><span className={`px-2 py-1 rounded text-xs font-semibold ${row.type === 'Student Payment' ? 'bg-emerald-500/20 text-emerald-300' : row.type === 'Future (done)' ? 'bg-green-500/20 text-green-300' : 'bg-blue-500/20 text-blue-300'}`}>{row.type}</span></td>
                                      <td className="py-3 px-4 text-white">{row.name}</td>
                                      <td className="py-3 px-4 text-slate-300">{formatCurrency(row.amount, row.currency)}</td>
                                      <td className="py-3 px-4 text-slate-300">{row.currency}</td>
                                      <td className="py-3 px-4 text-slate-300">{row.date ? new Date(row.date).toLocaleDateString() : '—'}</td>
                                      <td className="py-3 px-4 text-slate-300">{row.paymentMethod}</td>
                                      <td className="py-3 px-4 text-slate-300">{row.status}</td>
                                    </tr>
                                  ));
                                })()}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {overviewExpandedCard === 'pending_balance' && (
                        <div className="space-y-6">
                          {studentPayments.filter((p) => p.balance_amount > 0).length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Student pending balance</p>
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                                  <tr><th className="text-left py-3 px-4">Student</th><th className="text-left py-3 px-4">Balance</th><th className="text-left py-3 px-4">Currency</th><th className="text-left py-3 px-4">Status</th></tr>
                                </thead>
                                <tbody>
                                  {studentPayments.filter((p) => p.balance_amount > 0).map((p) => {
                                    const student = studentRecords.find((s) => s.id === p.student_id);
                                    return (
                                      <tr key={p.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                        <td className="py-3 px-4 text-white">{student?.student_name || '—'}</td>
                                        <td className="py-3 px-4 text-slate-300">{formatCurrency(p.balance_amount, p.currency)}</td>
                                        <td className="py-3 px-4 text-slate-300">{p.currency}</td>
                                        <td className="py-3 px-4 text-slate-300">{p.payment_status?.replace('_', ' ') || '—'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {pendingFuturePayments.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Future payments (pending balance)</p>
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                                  <tr><th className="text-left py-3 px-4">Sender</th><th className="text-left py-3 px-4">Amount</th><th className="text-left py-3 px-4">Currency</th><th className="text-left py-3 px-4">Expected date</th><th className="text-left py-3 px-4">Category</th></tr>
                                </thead>
                                <tbody>
                                  {pendingFuturePayments.map((fp) => (
                                    <tr key={fp.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                      <td className="py-3 px-4 text-white">{fp.sender_name}</td>
                                      <td className="py-3 px-4 text-slate-300">{formatCurrency(fp.amount, fp.currency)}</td>
                                      <td className="py-3 px-4 text-slate-300">{fp.currency}</td>
                                      <td className="py-3 px-4 text-slate-300">{fp.payment_date ? new Date(fp.payment_date).toLocaleDateString() : '—'}</td>
                                      <td className="py-3 px-4 text-slate-300">{fp.category === 'Other' ? (fp.custom_category?.trim() || 'Other') : fp.category}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {studentPayments.filter((p) => p.balance_amount > 0).length === 0 && pendingFuturePayments.length === 0 && (
                            <p className="py-8 px-4 text-slate-400 text-center">No pending balance</p>
                          )}
                        </div>
                      )}
                      {overviewExpandedCard === 'delayed' && (
                        <div className="space-y-6">
                          {comprehensiveAnalytics.delayedPayments.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Delayed student payments ({comprehensiveAnalytics.delayedPayments.length})</p>
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                                  <tr><th className="text-left py-3 px-4">Student</th><th className="text-left py-3 px-4">Due</th><th className="text-left py-3 px-4">Balance</th></tr>
                                </thead>
                                <tbody>
                                  {comprehensiveAnalytics.delayedPayments.map((p) => {
                                    const student = studentRecords.find((s) => s.id === p.student_id);
                                    const due = p.payment_date ? new Date(p.payment_date) : null;
                                    const now = new Date();
                                    const daysOverdue = due ? Math.floor((now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000)) : 0;
                                    return (
                                      <tr key={p.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                        <td className="py-3 px-4 text-white">{student?.student_name || '—'}</td>
                                        <td className="py-3 px-4 text-slate-300">{due ? due.toLocaleDateString() : '—'} {daysOverdue > 0 && <span className="text-red-400">({daysOverdue}d overdue)</span>}</td>
                                        <td className="py-3 px-4 text-slate-300">{formatCurrency(p.balance_amount, p.currency)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {delayedFuturePayments.length > 0 && (
                            <div>
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Delayed future payments ({delayedFuturePayments.length})</p>
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                                  <tr><th className="text-left py-3 px-4">Sender</th><th className="text-left py-3 px-4">Due</th><th className="text-left py-3 px-4">Amount</th><th className="text-left py-3 px-4">Category</th><th className="text-left py-3 px-4">Days overdue</th></tr>
                                </thead>
                                <tbody>
                                  {delayedFuturePayments.map((fp) => {
                                    const due = fp.payment_date ? new Date(fp.payment_date) : null;
                                    const now = new Date();
                                    const daysOverdue = due ? Math.floor((now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000)) : 0;
                                    return (
                                      <tr key={fp.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                        <td className="py-3 px-4 text-white">{fp.sender_name}</td>
                                        <td className="py-3 px-4 text-slate-300">{due ? due.toLocaleDateString() : '—'}</td>
                                        <td className="py-3 px-4 text-slate-300">{formatCurrency(fp.amount, fp.currency)}</td>
                                        <td className="py-3 px-4 text-slate-300">{fp.category === 'Other' ? (fp.custom_category?.trim() || 'Other') : fp.category}</td>
                                        <td className="py-3 px-4"><span className="text-red-400 font-semibold">{daysOverdue} days</span></td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {comprehensiveAnalytics.delayedPayments.length === 0 && delayedFuturePayments.length === 0 && (
                            <p className="py-8 px-4 text-slate-400 text-center">No delayed payments</p>
                          )}
                        </div>
                      )}
                      {overviewExpandedCard === 'paid' && (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                            <tr><th className="text-left py-3 px-4">Student</th><th className="text-left py-3 px-4">Amount</th><th className="text-left py-3 px-4">Date</th></tr>
                          </thead>
                          <tbody>
                            {studentPayments.filter((p) => p.payment_status === 'paid_completely').length === 0 ? (
                              <tr><td colSpan={3} className="py-8 px-4 text-slate-400 text-center">None</td></tr>
                            ) : studentPayments.filter((p) => p.payment_status === 'paid_completely').map((p) => {
                              const student = studentRecords.find((s) => s.id === p.student_id);
                              return (
                                <tr key={p.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                  <td className="py-3 px-4 text-white">{student?.student_name || '—'}</td>
                                  <td className="py-3 px-4 text-slate-300">{formatCurrency(p.amount, p.currency)}</td>
                                  <td className="py-3 px-4 text-slate-300">{p.payment_date ? new Date(p.payment_date).toLocaleDateString() : '—'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                      {overviewExpandedCard === 'partial' && (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                            <tr><th className="text-left py-3 px-4">Student</th><th className="text-left py-3 px-4">Amount</th><th className="text-left py-3 px-4">Balance</th></tr>
                          </thead>
                          <tbody>
                            {studentPayments.filter((p) => p.payment_status === 'paid_partially').length === 0 ? (
                              <tr><td colSpan={3} className="py-8 px-4 text-slate-400 text-center">None</td></tr>
                            ) : studentPayments.filter((p) => p.payment_status === 'paid_partially').map((p) => {
                              const student = studentRecords.find((s) => s.id === p.student_id);
                              return (
                                <tr key={p.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                  <td className="py-3 px-4 text-white">{student?.student_name || '—'}</td>
                                  <td className="py-3 px-4 text-slate-300">{formatCurrency(p.amount, p.currency)}</td>
                                  <td className="py-3 px-4 text-slate-300">{formatCurrency(p.balance_amount, p.currency)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                      {overviewExpandedCard === 'unpaid' && (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                            <tr><th className="text-left py-3 px-4">Student</th><th className="text-left py-3 px-4">Amount</th><th className="text-left py-3 px-4">Balance</th></tr>
                          </thead>
                          <tbody>
                            {studentPayments.filter((p) => p.payment_status === 'unpaid').length === 0 ? (
                              <tr><td colSpan={3} className="py-8 px-4 text-slate-400 text-center">None</td></tr>
                            ) : studentPayments.filter((p) => p.payment_status === 'unpaid').map((p) => {
                              const student = studentRecords.find((s) => s.id === p.student_id);
                              return (
                                <tr key={p.id} className="border-t border-slate-700/50 hover:bg-white/5">
                                  <td className="py-3 px-4 text-white">{student?.student_name || '—'}</td>
                                  <td className="py-3 px-4 text-slate-300">{formatCurrency(p.amount, p.currency)}</td>
                                  <td className="py-3 px-4 text-slate-300">{formatCurrency(p.balance_amount, p.currency)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )}

                {/* Charts Section */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Monthly Payment Trends - Bar Chart */}
                  <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-white">Monthly Payment Trends</h3>
                      <BarChart3 className="w-5 h-5 text-cyan-400" />
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={Object.entries(comprehensiveAnalytics.monthlyTrends).map(([month, data]) => ({
                        month: new Date(month + '-01').toLocaleDateString('en-US', { month: 'short' }),
                        monthKey: month,
                        received: data.received,
                        sent: data.sent,
                        receivedByCurrency: data.receivedByCurrency || {},
                        sentByCurrency: data.sentByCurrency || {},
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="month" stroke="#94a3b8" />
                        <YAxis stroke="#94a3b8" />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }}
                          labelStyle={{ color: '#f1f5f9' }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const row = payload[0]?.payload;
                            const receivedByCurrency = row?.receivedByCurrency as Record<string, number> | undefined || {};
                            const sentByCurrency = row?.sentByCurrency as Record<string, number> | undefined || {};
                            const fmt = (byCur: Record<string, number>) => {
                              const inr = (byCur['INR'] ?? 0);
                              const usd = (byCur['USD'] ?? 0);
                              const parts = [`INR: ${formatCurrency(inr, 'INR')}`, `USD: ${formatCurrency(usd, 'USD')}`];
                              Object.entries(byCur).forEach(([cur, amt]) => {
                                if (cur !== 'INR' && cur !== 'USD' && amt) parts.push(`${cur}: ${formatCurrency(amt, cur)}`);
                              });
                              return parts.join(' • ');
                            };
                            const receivedStr = fmt(receivedByCurrency);
                            const sentStr = fmt(sentByCurrency);
                            return (
                              <div className="px-3 py-2.5 text-sm min-w-[200px]">
                                <p className="font-semibold text-white mb-2.5">{label}</p>
                                <p className="mb-1.5">
                                  <span className="text-slate-300">Received: </span>
                                  <span className="text-emerald-300 font-medium">{receivedStr}</span>
                                </p>
                                <p>
                                  <span className="text-slate-300">Sent: </span>
                                  <span className="text-amber-300 font-medium">{sentStr}</span>
                                </p>
                              </div>
                            );
                          }}
                        />
                        <Legend />
                        <Bar dataKey="received" fill="#10b981" name="Received" />
                        <Bar dataKey="sent" fill="#f59e0b" name="Sent" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Pie Chart 1: Payment Methods / Pie Chart 2: Status (Future vs Delayed vs Done) */}
                  <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                    <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                      <h3 className="text-lg font-bold text-white">
                        {overviewPieChartVariant === 'methods' ? 'Payment Methods' : 'Status (Future / Delayed / Done)'}
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setOverviewPieChartVariant('methods')}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${overviewPieChartVariant === 'methods' ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50' : 'bg-slate-700/50 text-slate-400 hover:text-white'}`}
                        >
                          Payment Methods
                        </button>
                        <button
                          type="button"
                          onClick={() => setOverviewPieChartVariant('status')}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${overviewPieChartVariant === 'status' ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50' : 'bg-slate-700/50 text-slate-400 hover:text-white'}`}
                        >
                          Future / Delayed / Done
                        </button>
                        <CreditCard className="w-5 h-5 text-cyan-400" />
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      {overviewPieChartVariant === 'methods' ? (
                        (() => {
                          const methodEntries = Object.entries(comprehensiveAnalytics.paymentMethodDistribution);
                          const methodData = methodEntries.map(([method, count]) => ({ name: method, value: count }));
                          const colors = ['#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
                          if (methodData.length === 0) {
                            return (
                              <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                                No payment method data (partial or completed payments only).
                              </div>
                            );
                          }
                          return (
                            <PieChart>
                              <Pie
                                data={methodData}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(0)}%`}
                                outerRadius={100}
                                fill="#8884d8"
                                dataKey="value"
                              >
                                {methodData.map((_, index) => (
                                  <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }} />
                            </PieChart>
                          );
                        })()
                      ) : (
                        (() => {
                          if (statusPieData.length === 0) {
                            return (
                              <div className="h-full flex items-center justify-center text-slate-400 text-sm">
                                No pending, delayed, or done payments to show.
                              </div>
                            );
                          }
                          return (
                            <PieChart>
                              <Pie
                                data={statusPieData}
                                cx="50%"
                                cy="50%"
                                labelLine={false}
                                label={({ name, value, percent }) => `${name}: ${value} (${((percent || 0) * 100).toFixed(0)}%)`}
                                outerRadius={100}
                                dataKey="value"
                              >
                                {statusPieData.map((entry, index) => (
                                  <Cell key={`status-${index}`} fill={entry.fill} />
                                ))}
                              </Pie>
                              <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }} />
                            </PieChart>
                          );
                        })()
                      )}
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Calendar and Payments Section */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Calendar */}
                  <div className="lg:col-span-1 backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-bold text-white">
                        {currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </h3>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            const newMonth = new Date(currentMonth);
                            newMonth.setMonth(newMonth.getMonth() - 1);
                            setCurrentMonth(newMonth);
                          }}
                          className="p-1 hover:bg-slate-700 rounded transition-colors"
                        >
                          <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                          </svg>
                        </button>
                        <button
                          onClick={() => {
                            const newMonth = new Date(currentMonth);
                            newMonth.setMonth(newMonth.getMonth() + 1);
                            setCurrentMonth(newMonth);
                          }}
                          className="p-1 hover:bg-slate-700 rounded transition-colors"
                        >
                          <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    
                    {/* Calendar Grid */}
                    <div className="grid grid-cols-7 gap-2 mb-2">
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                        <div key={day} className="text-center text-xs font-semibold text-slate-400 py-2">
                          {day}
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-2">
                      {(() => {
                        const firstDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
                        const lastDay = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
                        const startingDayOfWeek = firstDay.getDay();
                        const daysInMonth = lastDay.getDate();
                        const days = [];

                        // Empty cells for days before month starts
                        for (let i = 0; i < startingDayOfWeek; i++) {
                          days.push(<div key={`empty-${i}`} className="aspect-square" />);
                        }

                        // Days of the month: red = delayed, yellow = future expected, green = payments done
                        const todayStr = toLocalDateStr(new Date());
                        for (let day = 1; day <= daysInMonth; day++) {
                          const date = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day);
                          const dateStr = toLocalDateStr(date);
                          const hasDone = comprehensiveAnalytics.paymentsByDate[dateStr]?.payments?.length > 0;
                          const hasDelayed = comprehensiveAnalytics.delayedPayments.some((p) => p.payment_date === dateStr) || delayedFuturePayments.some((fp) => fp.payment_date === dateStr);
                          const hasFutureExpected = pendingFuturePayments.some((p) => p.payment_date === dateStr && dateStr >= todayStr);
                          const isSelected = toLocalDateStr(selectedCalendarDate) === dateStr;
                          const isToday = todayStr === dateStr;

                          let dayBg = 'text-slate-300 hover:bg-slate-700/50';
                          if (hasDelayed) dayBg = 'bg-red-500/30 text-red-200 hover:bg-red-500/40';
                          else if (hasFutureExpected) dayBg = 'bg-amber-500/30 text-amber-200 hover:bg-amber-500/40';
                          else if (hasDone) dayBg = 'bg-green-500/30 text-green-200 hover:bg-green-500/40';

                          days.push(
                            <button
                              key={day}
                              onClick={() => setSelectedCalendarDate(date)}
                              className={`aspect-square flex flex-col items-center justify-center rounded-lg text-sm transition-all ${
                                isSelected ? 'bg-cyan-500 text-white font-bold ring-2 ring-cyan-400' : isToday ? 'bg-slate-600 text-white font-semibold' : dayBg
                              }`}
                            >
                              <span>{day}</span>
                              {!isSelected && (hasDelayed || hasFutureExpected || hasDone) && (
                                <span className={`text-[10px] ${hasDelayed ? 'text-red-300' : hasFutureExpected ? 'text-amber-300' : 'text-green-300'}`}>
                                  {hasDelayed && (comprehensiveAnalytics.delayedPayments.filter((p) => p.payment_date === dateStr).length + delayedFuturePayments.filter((fp) => fp.payment_date === dateStr).length)}
                                  {!hasDelayed && hasFutureExpected && pendingFuturePayments.filter((p) => p.payment_date === dateStr).length}
                                  {!hasDelayed && !hasFutureExpected && hasDone && comprehensiveAnalytics.paymentsByDate[dateStr]?.count}
                                </span>
                              )}
                            </button>
                          );
                        }

                        return days;
                      })()}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3 justify-center text-xs">
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-red-500/40" /> Delayed</span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-amber-500/40" /> Future</span>
                      <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-green-500/40" /> Done</span>
                    </div>
                  </div>

                  {/* Payments for Selected Date */}
                  <div className="lg:col-span-2 backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                    <h3 className="text-lg font-bold text-white mb-4">
                      Payments on {selectedCalendarDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    </h3>
                    <div className="space-y-3 max-h-[400px] overflow-y-auto">
                      {(() => {
                        const dateStr = toLocalDateStr(selectedCalendarDate);
                        const dayPayments = comprehensiveAnalytics.paymentsByDate[dateStr];
                        const paidPayments = dayPayments?.payments ?? [];
                        const futureOnDate = pendingFuturePayments.filter((p) => p.payment_date === dateStr);
                        const hasAny = paidPayments.length > 0 || futureOnDate.length > 0;

                        if (!hasAny) {
                          return (
                            <div className="text-center py-8">
                              <Calendar className="w-12 h-12 text-slate-500 mx-auto mb-3" />
                              <p className="text-slate-400">No payments on this date</p>
                            </div>
                          );
                        }

                        return (
                          <div className="space-y-4">
                            {paidPayments.length > 0 && (
                              <div>
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                                  Paid / Student payments ({paidPayments.length})
                                </p>
                                <div className="space-y-3">
                                  {paidPayments.map((payment: any, index: number) => {
                                    const student = payment.student_id ? studentRecords.find((s) => s.id === payment.student_id) : null;
                                    return (
                                      <div key={`paid-${index}`} className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
                                        <div className="flex items-start justify-between">
                                          <div className="flex-1">
                                            <p className="text-white font-medium">
                                              {payment.recipient_name || student?.student_name || 'Payment'}
                                            </p>
                                            <p className="text-sm text-slate-400 mt-1">
                                              {payment.payment_method || payment.payment_mode} • {payment.payment_currency || payment.currency}
                                            </p>
                                            {payment.payment_status && (
                                              <span className={`inline-block mt-2 px-2 py-1 rounded text-xs font-semibold ${
                                                payment.payment_status === 'paid_completely'
                                                  ? 'bg-green-500/20 text-green-300'
                                                  : payment.payment_status === 'paid_partially'
                                                  ? 'bg-yellow-500/20 text-yellow-300'
                                                  : 'bg-red-500/20 text-red-300'
                                              }`}>
                                                {payment.payment_status.replace('_', ' ')}
                                              </span>
                                            )}
                                          </div>
                                          <div className="text-right">
                                            <p className="text-lg font-bold text-white">
                                              {formatCurrency(payment.payment_amount || payment.amount, payment.payment_currency || payment.currency)}
                                            </p>
                                            {payment.balance_amount > 0 && (
                                              <p className="text-xs text-orange-300 mt-1">
                                                Balance: {formatCurrency(payment.balance_amount, payment.payment_currency || payment.currency)}
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {futureOnDate.length > 0 && (
                              <div>
                                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                                  Future / Expected payments ({futureOnDate.length})
                                </p>
                                <div className="space-y-3">
                                  {futureOnDate.map((fp) => {
                                    const todayStr = toLocalDateStr(new Date());
                                    const isDelayed = fp.payment_date < todayStr;
                                    return (
                                      <div
                                        key={fp.id}
                                        className={`rounded-lg p-4 border ${
                                          isDelayed ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'
                                        }`}
                                      >
                                        <div className="flex items-start justify-between">
                                          <div className="flex-1">
                                            <p className="text-white font-medium">{fp.sender_name}</p>
                                            <p className="text-sm text-slate-400 mt-1">
                                              {fp.category === 'Other' ? (fp.custom_category?.trim() || 'Other') : fp.category} • {fp.currency}
                                            </p>
                                            <span
                                              className={`inline-block mt-2 px-2 py-1 rounded text-xs font-semibold ${
                                                isDelayed ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'
                                              }`}
                                            >
                                              {isDelayed ? 'Delayed' : 'Future'}
                                            </span>
                                          </div>
                                          <div className="text-right">
                                            <p className="text-lg font-bold text-white">{formatCurrency(fp.amount, fp.currency)}</p>
                                            {fp.notes && <p className="text-xs text-slate-400 mt-1">{fp.notes}</p>}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Search by Credited To (Bank Holder) */}
                <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                  <div className="flex items-center gap-3 mb-4">
                    <User className="w-6 h-6 text-cyan-400" />
                    <h3 className="text-lg font-bold text-white">Search by Credited To</h3>
                  </div>
                  <p className="text-sm text-slate-400 mb-4">
                    Enter the bank holder name or the person whose account was credited with money to see all payments credited to them.
                  </p>
                  <div className="relative mb-6">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                      type="text"
                      value={creditedToSearchQuery}
                      onChange={(e) => setCreditedToSearchQuery(e.target.value)}
                      placeholder="e.g. John Doe, ABC Bank Holder..."
                      className="w-full pl-10 pr-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                    />
                  </div>

                  {creditedToSearchQuery.trim() ? (
                    creditedToSearchResults.totalCount === 0 ? (
                      <div className="text-center py-8">
                        <User className="w-12 h-12 text-slate-500 mx-auto mb-3" />
                        <p className="text-slate-400">No payments found credited to &quot;{creditedToSearchQuery.trim()}&quot;</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <p className="text-slate-300">
                            <span className="font-semibold text-cyan-400">{creditedToSearchResults.totalCount}</span> payment(s)
                            {Object.keys(creditedToSearchResults.byCurrency).length > 0 && (
                              <span className="ml-2">
                                {Object.entries(creditedToSearchResults.byCurrency)
                                  .sort(([a], [b]) => a.localeCompare(b))
                                  .map(([currency, amount], index) => (
                                    <span key={currency} className="font-semibold text-green-400">
                                      {index > 0 ? ' • ' : ''}
                                      {currency}: {formatCurrency(amount, currency)}
                                    </span>
                                  ))}
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                          <table className="w-full" style={{ tableLayout: 'auto' }}>
                            <thead className="sticky top-0 bg-slate-900/95 backdrop-blur-xl z-10">
                              <tr className="border-b border-slate-700">
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Type</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300 whitespace-nowrap">Sender</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300 whitespace-nowrap">Receiver</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Amount</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Currency</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Date</th>
                                <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Method / Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {creditedToSearchResults.paymentRecords.map((record) => (
                                <tr key={`pr-${record.id}`} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                                  <td className="py-3 px-4">
                                    <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs font-semibold">Payment Record</span>
                                  </td>
                                  <td className="py-3 px-4 text-slate-200 whitespace-normal break-words">
                                    {record.sender_name || record.submitted_by_email || '—'}
                                  </td>
                                  <td className="py-3 px-4 text-slate-200 whitespace-normal break-words">
                                    {record.receiver_bank_holder || record.recipient_name || '—'}
                                  </td>
                                  <td className="py-3 px-4 text-white font-semibold">
                                    {formatCurrency(record.payment_amount || 0, record.payment_currency)}
                                  </td>
                                  <td className="py-3 px-4 text-slate-300">{record.payment_currency || '-'}</td>
                                  <td className="py-3 px-4 text-slate-300">{record.payment_date ? formatDate(record.payment_date) : '-'}</td>
                                  <td className="py-3 px-4 text-slate-300">{record.payment_method || '-'}</td>
                                </tr>
                              ))}
                              {creditedToSearchResults.studentPayments.map((payment) => {
                                const student = studentRecords.find((s) => s.id === payment.student_id);
                                return (
                                  <tr key={`sp-${payment.id}`} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                                    <td className="py-3 px-4">
                                      <span className="px-2 py-1 bg-emerald-500/20 text-emerald-300 rounded text-xs font-semibold">Student Payment</span>
                                    </td>
                                    <td className="py-3 px-4 text-slate-200 whitespace-normal break-words">
                                      {student?.student_name || '—'}
                                    </td>
                                    <td className="py-3 px-4 text-slate-200 whitespace-normal break-words">
                                      {payment.credited_to || '—'}
                                    </td>
                                    <td className="py-3 px-4 text-white font-semibold">
                                      {formatCurrency(payment.amount || 0, payment.currency)}
                                    </td>
                                    <td className="py-3 px-4 text-slate-300">{payment.currency || '-'}</td>
                                    <td className="py-3 px-4 text-slate-300">{payment.payment_date ? formatDate(payment.payment_date) : '-'}</td>
                                    <td className="py-3 px-4">
                                      <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                        payment.payment_status === 'paid_completely' ? 'bg-green-500/20 text-green-300' :
                                        payment.payment_status === 'paid_partially' ? 'bg-yellow-500/20 text-yellow-300' : 'bg-red-500/20 text-red-300'
                                      }`}>
                                        {payment.payment_status?.replace('_', ' ') || '-'}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="text-center py-6 text-slate-500 text-sm">
                      Type a name above to see all payments credited to that bank holder or recipient.
                    </div>
                  )}
                </div>

                {/* Delayed Payments Section */}
                {(comprehensiveAnalytics.delayedPayments.length > 0 || delayedFuturePayments.length > 0) && (
                  <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-6">
                    <div className="flex items-center gap-3 mb-4">
                      <AlertCircle className="w-6 h-6 text-red-400" />
                      <h3 className="text-lg font-bold text-white">Delayed/Overdue Payments</h3>
                      <span className="px-3 py-1 bg-red-500/20 text-red-300 rounded-full text-sm font-semibold">
                        {comprehensiveAnalytics.delayedPayments.length + delayedFuturePayments.length} overdue
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-slate-700">
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Type</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Name / Student</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Due Date</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Amount</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Balance</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Days Overdue</th>
                            <th className="text-left py-3 px-4 text-sm font-semibold text-slate-300">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {comprehensiveAnalytics.delayedPayments.map((payment: any) => {
                            const daysOverdue = Math.floor((new Date().getTime() - new Date(payment.payment_date).getTime()) / (1000 * 60 * 60 * 24));
                            const student = studentRecords.find(s => s.id === payment.student_id);
                            return (
                              <tr key={`sp-${payment.id}`} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                                <td className="py-3 px-4">
                                  <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs font-semibold">Student</span>
                                </td>
                                <td className="py-3 px-4 text-slate-200">{student?.student_name || 'Unknown'}</td>
                                <td className="py-3 px-4 text-slate-300">{new Date(payment.payment_date).toLocaleDateString()}</td>
                                <td className="py-3 px-4 text-slate-200">{formatCurrency(payment.amount, payment.currency)}</td>
                                <td className="py-3 px-4 text-red-300 font-semibold">{formatCurrency(payment.balance_amount, payment.currency)}</td>
                                <td className="py-3 px-4">
                                  <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                    daysOverdue > 30 ? 'bg-red-500/20 text-red-300' : daysOverdue > 7 ? 'bg-orange-500/20 text-orange-300' : 'bg-yellow-500/20 text-yellow-300'
                                  }`}>{daysOverdue} days</span>
                                </td>
                                <td className="py-3 px-4">
                                  <span className="px-2 py-1 bg-yellow-500/20 text-yellow-300 rounded text-xs font-semibold">{payment.payment_status.replace('_', ' ')}</span>
                                </td>
                              </tr>
                            );
                          })}
                          {delayedFuturePayments.map((fp) => {
                            const daysOverdue = fp.payment_date ? Math.floor((new Date().getTime() - new Date(fp.payment_date).getTime()) / (1000 * 60 * 60 * 24)) : 0;
                            return (
                              <tr key={`fp-${fp.id}`} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                                <td className="py-3 px-4">
                                  <span className="px-2 py-1 bg-amber-500/20 text-amber-300 rounded text-xs font-semibold">Future</span>
                                </td>
                                <td className="py-3 px-4 text-slate-200">{fp.sender_name}</td>
                                <td className="py-3 px-4 text-slate-300">{fp.payment_date ? new Date(fp.payment_date).toLocaleDateString() : '—'}</td>
                                <td className="py-3 px-4 text-slate-200">{formatCurrency(fp.amount, fp.currency)}</td>
                                <td className="py-3 px-4 text-slate-400">—</td>
                                <td className="py-3 px-4">
                                  <span className="px-2 py-1 rounded text-xs font-semibold bg-red-500/20 text-red-300">{daysOverdue} days</span>
                                </td>
                                <td className="py-3 px-4">
                                  <span className="px-2 py-1 bg-red-500/20 text-red-300 rounded text-xs font-semibold">Delayed</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'payments' && (
          <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-8">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-2">Payment Records</h2>
            <p className="text-slate-300">
              {!loading && !error && records.length > 0
                ? `Showing ${filteredPaymentRecords.length} of ${records.length} records`
                : 'View and manage all submitted payment records'}
            </p>
          </div>

          {!loading && !error && records.length > 0 && (
            <div className="mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by recipient, method, currency, bank holder, UTR, or notes..."
                  value={paymentRecordsSearchQuery}
                  onChange={(e) => setPaymentRecordsSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200">
              {error}
            </div>
          ) : records.length === 0 ? (
            <div className="text-center py-12">
              <CreditCard className="w-16 h-16 text-slate-400 mx-auto mb-4" />
              <p className="text-slate-300 text-lg">No payment records yet</p>
              <p className="text-slate-400 text-sm mt-2">Records will appear here once users submit them</p>
            </div>
          ) : filteredPaymentRecords.length === 0 ? (
            <div className="text-center py-12">
              <Search className="w-16 h-16 text-slate-400 mx-auto mb-4" />
              <p className="text-slate-300 text-lg">No records found</p>
              <p className="text-slate-400 text-sm mt-2">Try adjusting your search query</p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-slate-900/95 backdrop-blur-xl z-10">
                  <tr className="border-b border-slate-700">
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <User className="w-4 h-4 inline mr-2" />
                      Recipient
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <CreditCard className="w-4 h-4 inline mr-2" />
                      Method
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <CreditCard className="w-4 h-4 inline mr-2" />
                      Type
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <DollarSign className="w-4 h-4 inline mr-2" />
                      Currency
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <DollarSign className="w-4 h-4 inline mr-2" />
                      Amount
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <Calendar className="w-4 h-4 inline mr-2" />
                      Date
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <Building className="w-4 h-4 inline mr-2" />
                      Bank Holder
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <Hash className="w-4 h-4 inline mr-2" />
                      UTR
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      <FileText className="w-4 h-4 inline mr-2" />
                      Notes
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      Screenshot
                    </th>
                    <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPaymentRecords.map((record) => (
                    <tr key={record.id} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                      <td className="py-4 px-4 text-slate-300">{record.recipient_name}</td>
                      <td className="py-4 px-4 text-slate-300">{record.payment_method}</td>
                      <td className="py-4 px-4">
                        <span className={`px-2 py-1 rounded-lg text-xs font-semibold ${
                          record.payment_type === 'Received'
                            ? 'bg-green-500/20 text-green-300 border border-green-500/50'
                            : 'bg-orange-500/20 text-orange-300 border border-orange-500/50'
                        }`}>
                          {record.payment_type}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-slate-300">{record.payment_currency}</td>
                      <td className="py-4 px-4 text-slate-300 font-semibold">
                        {formatCurrency(record.payment_amount, record.payment_currency)}
                      </td>
                      <td className="py-4 px-4 text-slate-300">{formatDate(record.payment_date)}</td>
                      <td className="py-4 px-4 text-slate-300">{record.receiver_bank_holder}</td>
                      <td className="py-4 px-4 text-slate-300 font-mono text-sm">
                        {record.utr_number || '-'}
                      </td>
                      <td className="py-4 px-4 text-slate-300 max-w-xs truncate">
                        {record.requirements || '-'}
                      </td>
                      <td className="py-4 px-4">
                        <button
                          onClick={() => {
                            const urls = record.payment_screenshot_url ? [record.payment_screenshot_url] : [];
                            setSelectedImages(urls);
                            setSelectedImageIndex(0);
                          }}
                          className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg transition-all text-sm"
                          disabled={!record.payment_screenshot_url}
                        >
                          <Eye className="w-4 h-4" />
                          View
                        </button>
                      </td>
                      <td className="py-4 px-4">
                        <button
                          onClick={() => handleDeletePaymentRecord(record.id)}
                          className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-all text-sm"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </div>
        )}

        {activeTab === 'future' && (
          <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-8">
          <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Clock className="w-6 h-6 text-green-400" />
                <h2 className="text-2xl font-bold text-white">Future Repayments</h2>
              </div>
              <p className="text-slate-300">Expected repayments and scheduled transactions</p>
            </div>
            <button
              type="button"
              onClick={() => { setError(''); setShowAddFuturePaymentModal(true); }}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-lg font-medium shadow-lg shadow-green-500/30 transition-all"
            >
              <Plus className="w-5 h-5" />
              Add Future Repayment
            </button>
          </div>

          {!futurePaymentsLoading && futurePayments.length > 0 && (
            <div className="mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by sender, category, currency, or notes..."
                  value={futurePaymentsSearchQuery}
                  onChange={(e) => setFuturePaymentsSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          {futurePaymentsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-8 h-8 text-green-400 animate-spin" />
            </div>
          ) : futurePayments.length === 0 ? (
            <div className="text-center py-12">
              <Clock className="w-16 h-16 text-slate-400 mx-auto mb-4" />
              <p className="text-slate-300 text-lg">No future repayments scheduled</p>
              <p className="text-slate-400 text-sm mt-2">Future repayment records will appear here</p>
            </div>
          ) : filteredFuturePayments.length === 0 ? (
            <div className="text-center py-12">
              <Search className="w-16 h-16 text-slate-400 mx-auto mb-4" />
              <p className="text-slate-300 text-lg">No payments found</p>
              <p className="text-slate-400 text-sm mt-2">Try adjusting your search query</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="backdrop-blur-xl bg-gradient-to-br from-green-500/20 to-emerald-500/20 border border-green-500/30 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-slate-300">Total Future Repayments</p>
                    <Clock className="w-4 h-4 text-green-400" />
                  </div>
                  <p className="text-3xl font-bold text-white">{futurePaymentAnalytics.totalFuturePayments}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Total: {formatCurrency(futurePaymentAnalytics.totalAmount, 'USD')}
                  </p>
                </div>

                <div className="backdrop-blur-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-slate-300">This Week</p>
                    <Calendar className="w-4 h-4 text-blue-400" />
                  </div>
                  <p className="text-3xl font-bold text-white">{futurePaymentAnalytics.upcomingThisWeek}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    Amount: {formatCurrency(futurePaymentAnalytics.upcomingThisWeekAmount, 'USD')}
                  </p>
                </div>

                {Object.entries(futurePaymentAnalytics.byCategory).slice(0, 2).map(([category, data]) => (
                  <div key={category} className="backdrop-blur-xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/30 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm text-slate-300">{category}</p>
                      <Building className="w-4 h-4 text-purple-400" />
                    </div>
                    <p className="text-2xl font-bold text-white">{data.count}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      Total: {formatCurrency(data.total, 'USD')}
                    </p>
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-slate-900/95 backdrop-blur-xl z-10">
                    <tr className="border-b border-slate-700">
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <User className="w-4 h-4 inline mr-2" />
                        Sender
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        Email
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <DollarSign className="w-4 h-4 inline mr-2" />
                        Currency
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <DollarSign className="w-4 h-4 inline mr-2" />
                        Amount
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <Building className="w-4 h-4 inline mr-2" />
                        Category
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <Calendar className="w-4 h-4 inline mr-2" />
                        Expected Date
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <FileText className="w-4 h-4 inline mr-2" />
                        Notes
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <Calendar className="w-4 h-4 inline mr-2" />
                        Submitted
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        Status
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFuturePayments.map((payment) => {
                      const isPastDue = new Date(payment.payment_date) < new Date();
                      const isDone = (payment.status || 'pending') === 'done';
                      const displayCategory = payment.category === 'Other'
                        ? (payment.custom_category?.trim() || 'Other')
                        : (payment.category || '—');
                      return (
                        <tr key={payment.id} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                          <td className="py-4 px-4 text-slate-300">{payment.sender_name}</td>
                          <td className="py-4 px-4 text-slate-300">{payment.email?.trim() || '—'}</td>
                          <td className="py-4 px-4 text-slate-300 font-mono">
                            {payment.currency || 'USD'}
                          </td>
                          <td className="py-4 px-4 text-slate-300 font-semibold">
                            {formatCurrency(payment.amount, payment.currency)}
                          </td>
                          <td className="py-4 px-4">
                            <span className="px-2 py-1 rounded-lg text-xs font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/50">
                              {displayCategory}
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`px-2 py-1 rounded-lg text-xs font-semibold ${
                              isPastDue
                                ? 'bg-red-500/20 text-red-300 border border-red-500/50'
                                : 'bg-green-500/20 text-green-300 border border-green-500/50'
                            }`}>
                              {formatDate(payment.payment_date)}
                            </span>
                          </td>
                          <td className="py-4 px-4 text-slate-300 max-w-xs truncate">
                            {payment.notes || '-'}
                          </td>
                          <td className="py-4 px-4 text-slate-400 text-sm">
                            {formatDate(payment.created_at)}
                          </td>
                          <td className="py-4 px-4">
                            {isDone ? (
                              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-semibold bg-green-500/20 text-green-300 border border-green-500/50">
                                <Check className="w-3.5 h-3.5" />
                                Done
                              </span>
                            ) : (
                              <span className="px-2 py-1 rounded-lg text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/50">
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="py-4 px-4">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button
                                onClick={() => handleEditFuturePayment(payment)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg transition-all text-sm"
                              >
                                <Edit className="w-4 h-4" />
                                Edit
                              </button>
                              {!isDone && (
                                <button
                                  onClick={() => handleMarkFuturePaymentDone(payment.id)}
                                  className="flex items-center gap-2 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg transition-all text-sm"
                                >
                                  <Check className="w-4 h-4" />
                                  Mark as done
                                </button>
                              )}
                              <button
                                onClick={() => handleDeleteFuturePayment(payment.id)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg transition-all text-sm"
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {showEditFuturePaymentModal && selectedFuturePaymentForEdit && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowEditFuturePaymentModal(false)}>
              <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700 p-6 flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-white">Edit Future Repayment</h2>
                  <button type="button" onClick={() => setShowEditFuturePaymentModal(false)} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <form onSubmit={handleSaveEditFuturePayment} className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Sender Name</label>
                    <input
                      type="text"
                      value={editFuturePaymentData.sender_name}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, sender_name: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Email</label>
                    <input
                      type="email"
                      value={editFuturePaymentData.email}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, email: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Currency</label>
                    <select
                      value={editFuturePaymentData.currency}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, currency: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    >
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editFuturePaymentData.amount}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, amount: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Category</label>
                    <select
                      value={editFuturePaymentData.category}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, category: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    >
                      <option value="">Select category</option>
                      {FUTURE_PAYMENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {editFuturePaymentData.category === 'Other' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Custom Category</label>
                      <input
                        type="text"
                        value={editFuturePaymentData.customCategory}
                        onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, customCategory: e.target.value })}
                        className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        placeholder="e.g. assignment payment"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Expected Date</label>
                    <input
                      type="date"
                      value={editFuturePaymentData.payment_date}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, payment_date: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Notes (optional)</label>
                    <textarea
                      value={editFuturePaymentData.notes}
                      onChange={(e) => setEditFuturePaymentData({ ...editFuturePaymentData, notes: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                      rows={3}
                    />
                  </div>
                  {error && <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">{error}</div>}
                  <div className="flex gap-3 pt-4">
                    <button type="button" onClick={() => setShowEditFuturePaymentModal(false)} className="flex-1 py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={editFuturePaymentLoading} className="flex-1 py-3 px-4 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                      {editFuturePaymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                      Save changes
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {showAddFuturePaymentModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowAddFuturePaymentModal(false)}>
              <div className="bg-slate-900 rounded-2xl border border-slate-700 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="sticky top-0 bg-slate-900/95 backdrop-blur border-b border-slate-700 p-6 flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-white">Add Future Repayment</h2>
                  <button type="button" onClick={() => setShowAddFuturePaymentModal(false)} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <form onSubmit={handleSubmitAddFuturePayment} className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Sender Name</label>
                    <input
                      type="text"
                      value={addFuturePaymentData.sender_name}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, sender_name: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      placeholder="Enter sender name"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Email</label>
                    <input
                      type="email"
                      value={addFuturePaymentData.email}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, email: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      placeholder="Enter email (optional)"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Currency</label>
                    <select
                      value={addFuturePaymentData.currency}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, currency: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    >
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Amount</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={addFuturePaymentData.amount}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, amount: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      placeholder="0.00"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Category</label>
                    <select
                      value={addFuturePaymentData.category}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, category: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    >
                      <option value="">Select category</option>
                      {FUTURE_PAYMENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  {addFuturePaymentData.category === 'Other' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Custom Category</label>
                      <input
                        type="text"
                        value={addFuturePaymentData.customCategory}
                        onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, customCategory: e.target.value })}
                        className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                        placeholder="e.g. assignment payment"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Expected Date</label>
                    <input
                      type="date"
                      value={addFuturePaymentData.payment_date}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, payment_date: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Notes (optional)</label>
                    <textarea
                      value={addFuturePaymentData.notes}
                      onChange={(e) => setAddFuturePaymentData({ ...addFuturePaymentData, notes: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                      rows={3}
                      placeholder="Add any notes"
                    />
                  </div>
                  {error && <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">{error}</div>}
                  <div className="flex gap-3 pt-4">
                    <button type="button" onClick={() => setShowAddFuturePaymentModal(false)} className="flex-1 py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors">
                      Cancel
                    </button>
                    <button type="submit" disabled={addFuturePaymentLoading} className="flex-1 py-3 px-4 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                      {addFuturePaymentLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                      Add Future Repayment
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
          </div>
        )}

        {activeTab === 'students' && (
          <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-8">
          <div className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <GraduationCap className="w-6 h-6 text-cyan-400" />
              <h2 className="text-2xl font-bold text-white">Student Records</h2>
            </div>
            <p className="text-slate-300">View and manage all student records uploaded by users</p>
          </div>

          {studentRecordsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            </div>
          ) : studentRecords.length === 0 ? (
            <div className="text-center py-12">
              <GraduationCap className="w-16 h-16 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">No student records found</p>
              <button
                onClick={() => setShowAddStudentModal(true)}
                className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg transition-all shadow-lg shadow-cyan-500/50"
              >
                <Plus className="w-4 h-4" />
                Add Student
              </button>
            </div>
          ) : (
            <>
              <div className="mb-4 space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search by name, email, university, or subjects..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-slate-300 text-sm">
                    <span className="font-semibold text-cyan-400">{filteredStudents.length}</span> {searchQuery ? 'matching' : ''} students{searchQuery && ` of ${groupedStudents.length}`}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowExportModal(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-lg transition-all shadow-lg shadow-green-500/50"
                    >
                      <Download className="w-4 h-4" />
                      Export to Excel
                    </button>
                    <button
                      onClick={() => setShowAddStudentModal(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg transition-all shadow-lg shadow-cyan-500/50"
                    >
                      <Plus className="w-4 h-4" />
                      Add Student
                    </button>
                  </div>
                </div>
              </div>
              <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2">
                {filteredStudents.map((student) => {
                  return (
                    <div key={student.email} className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 overflow-hidden hover:bg-slate-700/30 transition-colors">
                      <div className="flex items-center justify-between p-4">
                        <div className="flex items-center gap-4 flex-1">
                          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div className="flex items-center gap-2">
                              <User className="w-4 h-4 text-cyan-400" />
                              <span
                                className="text-slate-200 font-medium hover:text-cyan-400 transition-colors cursor-pointer"
                                onClick={() => setSelectedStudentForPopup(student.records[0])}
                              >
                                {student.student_name}
                              </span>
                              {student.records[0].is_critical && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/50 text-xs font-medium">
                                  <AlertTriangle className="w-3 h-3" />
                                  Critical
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <Mail className="w-4 h-4 text-cyan-400" />
                              <span className="text-slate-300">{student.email || '-'}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Hash className="w-4 h-4 text-cyan-400" />
                              <span className="text-slate-300">{student.phone_number || '-'}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Building className="w-4 h-4 text-cyan-400" />
                              <span className="text-slate-300">{student.university || '-'}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleToggleCritical(student.records[0].id, !!student.records[0].is_critical)}
                            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                              student.records[0].is_critical
                                ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300'
                                : 'bg-slate-600/40 hover:bg-slate-600/60 text-slate-300'
                            }`}
                          >
                            <AlertTriangle className="w-4 h-4" />
                            {student.records[0].is_critical ? 'Unmark Critical' : 'Mark Critical'}
                          </button>
                          <button
                            onClick={() => handleEditStudentClick(student.records[0])}
                            className="flex items-center gap-1 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg text-sm transition-colors"
                          >
                            <Edit className="w-4 h-4" />
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteStudent(student.records[0].id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded-lg text-sm transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          </div>
        )}

        {activeTab === 'timeSpent' && (
          <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-8">
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-2">
                <Timer className="w-6 h-6 text-cyan-400" />
                <h2 className="text-2xl font-bold text-white">Time Spent</h2>
              </div>
              <p className="text-slate-300">User login history and time spent in the app</p>
            </div>

            {loginHistoryLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
              </div>
            ) : (
              <div className="space-y-6">
                {(() => {
                  const byUser = new Map<string, { email: string; totalSeconds: number; sessions: LoginHistoryEntry[] }>();
                  loginHistory.forEach((entry) => {
                    const key = entry.user_id;
                    if (!byUser.has(key)) {
                      byUser.set(key, { email: entry.email || '—', totalSeconds: 0, sessions: [] });
                    }
                    const u = byUser.get(key)!;
                    u.sessions.push(entry);
                    if (entry.duration_seconds != null) u.totalSeconds += entry.duration_seconds;
                  });
                  const summary = Array.from(byUser.entries()).map(([userId, data]) => ({
                    userId,
                    email: data.email,
                    totalSeconds: data.totalSeconds,
                    sessionCount: data.sessions.length,
                  }));

                  const formatDuration = (seconds: number) => {
                    const h = Math.floor(seconds / 3600);
                    const m = Math.floor((seconds % 3600) / 60);
                    const s = Math.floor(seconds % 60);
                    if (h > 0) return `${h}h ${m}m`;
                    if (m > 0) return `${m}m ${s}s`;
                    return `${s}s`;
                  };

                  return (
                    <>
                      <div className="backdrop-blur-xl bg-slate-800/50 rounded-xl border border-slate-700 p-4">
                        <h3 className="text-lg font-semibold text-white mb-3">Summary by user</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-600 text-slate-300">
                                <th className="text-left py-3 px-4">User (email)</th>
                                <th className="text-left py-3 px-4">Sessions</th>
                                <th className="text-left py-3 px-4">Total time spent</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summary.length === 0 ? (
                                <tr><td colSpan={3} className="py-6 text-slate-400 text-center">No login history yet</td></tr>
                              ) : (
                                summary.map((s) => (
                                  <tr key={s.userId} className="border-b border-slate-700/50 hover:bg-white/5">
                                    <td className="py-3 px-4 text-white">{s.email}</td>
                                    <td className="py-3 px-4 text-slate-300">{s.sessionCount}</td>
                                    <td className="py-3 px-4 text-cyan-300 font-medium">{formatDuration(s.totalSeconds)}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h3 className="text-lg font-semibold text-white mb-3">Login history (all sessions)</h3>
                        <div className="max-h-[500px] overflow-y-auto rounded-xl border border-slate-700">
                          <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-slate-800/95 text-slate-300 z-10">
                              <tr className="border-b border-slate-700">
                                <th className="text-left py-3 px-4">User (email)</th>
                                <th className="text-left py-3 px-4">Login at</th>
                                <th className="text-left py-3 px-4">Logout at</th>
                                <th className="text-left py-3 px-4">Duration</th>
                              </tr>
                            </thead>
                            <tbody>
                              {loginHistory.length === 0 ? (
                                <tr><td colSpan={4} className="py-8 text-slate-400 text-center">No login history yet</td></tr>
                              ) : (
                                loginHistory.map((entry) => (
                                  <tr key={entry.id} className="border-b border-slate-700/50 hover:bg-white/5">
                                    <td className="py-3 px-4 text-white">{entry.email || '—'}</td>
                                    <td className="py-3 px-4 text-slate-300">{entry.login_at ? new Date(entry.login_at).toLocaleString() : '—'}</td>
                                    <td className="py-3 px-4 text-slate-300">{entry.logout_at ? new Date(entry.logout_at).toLocaleString() : '—'}</td>
                                    <td className="py-3 px-4 text-slate-300">
                                      {entry.duration_seconds != null ? formatDuration(entry.duration_seconds) : '—'}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {activeTab === 'excelUploads' && (
          <div className="backdrop-blur-xl bg-white/10 rounded-2xl shadow-2xl border border-white/20 p-8">
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-2">
                <FileSpreadsheet className="w-6 h-6 text-cyan-400" />
                <h2 className="text-2xl font-bold text-white">Excel Uploads</h2>
              </div>
              <p className="text-slate-300">View all previously uploaded Excel files from admin and user dashboards</p>
            </div>

            {excelUploadsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
              </div>
            ) : excelUploads.length === 0 ? (
              <div className="text-center py-12">
                <FileSpreadsheet className="w-16 h-16 text-slate-400 mx-auto mb-4" />
                <p className="text-slate-300 text-lg">No Excel files uploaded yet</p>
                <p className="text-slate-400 text-sm mt-2">Uploaded Excel files will appear here</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <FileSpreadsheet className="w-4 h-4 inline mr-2" />
                        File Name
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <User className="w-4 h-4 inline mr-2" />
                        Upload Type
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <Hash className="w-4 h-4 inline mr-2" />
                        Records Count
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <DollarSign className="w-4 h-4 inline mr-2" />
                        File Size
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        <Calendar className="w-4 h-4 inline mr-2" />
                        Uploaded At
                      </th>
                      <th className="text-left py-4 px-4 text-sm font-semibold text-slate-200">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {excelUploads.map((upload) => (
                      <tr key={upload.id} className="border-b border-slate-800 hover:bg-white/5 transition-colors">
                        <td className="py-4 px-4 text-slate-300 font-medium">{upload.file_name}</td>
                        <td className="py-4 px-4">
                          <span className={`px-2 py-1 rounded-lg text-xs font-semibold ${
                            upload.upload_type === 'admin'
                              ? 'bg-red-500/20 text-red-300 border border-red-500/50'
                              : 'bg-blue-500/20 text-blue-300 border border-blue-500/50'
                          }`}>
                            {upload.upload_type === 'admin' ? 'Admin' : 'User'}
                          </span>
                        </td>
                        <td className="py-4 px-4 text-slate-300">{upload.records_count}</td>
                        <td className="py-4 px-4 text-slate-300">
                          {(upload.file_size / 1024).toFixed(2)} KB
                        </td>
                        <td className="py-4 px-4 text-slate-300">{formatDate(upload.created_at)}</td>
                        <td className="py-4 px-4">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleViewExcel(upload)}
                              className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 rounded-lg transition-all text-sm"
                            >
                              <Eye className="w-4 h-4" />
                              View
                            </button>
                            <button
                              onClick={() => handleDownloadExcel(upload)}
                              className="flex items-center gap-2 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg transition-all text-sm"
                            >
                              <Download className="w-4 h-4" />
                              Download
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {selectedImages.length > 0 && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-[9500]"
          onClick={() => { setSelectedImages([]); setSelectedImageIndex(0); }}
        >
          <div className="relative max-w-7xl max-h-[90vh] w-full h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setSelectedImages([]); setSelectedImageIndex(0); }}
              className="absolute top-4 right-4 p-3 bg-slate-800/90 hover:bg-slate-700 text-white rounded-full transition-all shadow-lg z-10"
            >
              <X className="w-6 h-6" />
            </button>
            {selectedImages.length > 1 && (
              <>
                <button
                  onClick={() => setSelectedImageIndex((i) => Math.max(0, i - 1))}
                  disabled={selectedImageIndex === 0}
                  className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-slate-800/90 hover:bg-slate-700 disabled:opacity-40 text-white rounded-full transition-all shadow-lg z-10"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  onClick={() => setSelectedImageIndex((i) => Math.min(selectedImages.length - 1, i + 1))}
                  disabled={selectedImageIndex === selectedImages.length - 1}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-slate-800/90 hover:bg-slate-700 disabled:opacity-40 text-white rounded-full transition-all shadow-lg z-10 mr-16"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-slate-800/90 text-white rounded-full text-sm">
                  {selectedImageIndex + 1} / {selectedImages.length}
                </div>
              </>
            )}
            <div className="relative w-full h-full flex items-center justify-center">
              <img
                src={selectedImages[selectedImageIndex]}
                alt={`Payment screenshot ${selectedImageIndex + 1}`}
                className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
              />
            </div>
          </div>
        </div>
      )}

      {showAddStudentModal && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => {
            setShowAddStudentModal(false);
            setAddStudentMode('manual');
            setStudentExcelFile(null);
          }}
        >
          <div
            className="relative max-w-2xl w-full backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-cyan-500 to-blue-500 rounded-lg shadow-lg shadow-cyan-500/50">
                  <Plus className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Add New Student</h2>
              </div>
              <button
                onClick={() => {
                  setShowAddStudentModal(false);
                  setAddStudentMode('manual');
                  setStudentExcelFile(null);
                }}
                className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex gap-4 mb-6">
              <button
                type="button"
                onClick={() => setAddStudentMode('manual')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  addStudentMode === 'manual'
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/50'
                    : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <User className="w-4 h-4 inline mr-2" />
                Manual Entry
              </button>
              <button
                type="button"
                onClick={() => setAddStudentMode('bulk')}
                className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                  addStudentMode === 'bulk'
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/50'
                    : 'bg-slate-800/50 text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <FileSpreadsheet className="w-4 h-4 inline mr-2" />
                Bulk Upload
              </button>
            </div>

            {addStudentMode === 'manual' ? (
              <form onSubmit={handleAddStudent} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <User className="w-4 h-4 inline mr-2" />
                  Student Name *
                </label>
                <input
                  type="text"
                  value={newStudentData.student_name}
                  onChange={(e) => setNewStudentData({ ...newStudentData, student_name: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Enter student name"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Mail className="w-4 h-4 inline mr-2" />
                  Email
                </label>
                <input
                  type="email"
                  value={newStudentData.email}
                  onChange={(e) => setNewStudentData({ ...newStudentData, email: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="student@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <span className="inline mr-2">🔑</span>
                  Password
                </label>
                <input
                  type="text"
                  value={newStudentData.password}
                  onChange={(e) => setNewStudentData({ ...newStudentData, password: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Student password"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Hash className="w-4 h-4 inline mr-2" />
                  Phone Number
                </label>
                <input
                  type="text"
                  value={newStudentData.phone_number}
                  onChange={(e) => setNewStudentData({ ...newStudentData, phone_number: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Phone number"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Building className="w-4 h-4 inline mr-2" />
                  University
                </label>
                <input
                  type="text"
                  value={newStudentData.university}
                  onChange={(e) => setNewStudentData({ ...newStudentData, university: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="University name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <BookOpen className="w-4 h-4 inline mr-2" />
                  Subjects
                </label>
                <input
                  type="text"
                  value={newStudentData.subjects}
                  onChange={(e) => setNewStudentData({ ...newStudentData, subjects: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="e.g., fall_1_maths, fall_1_physics, spring_2_chemistry"
                />
                <p className="text-xs text-slate-400 mt-2">
                  Enter subjects with term prefixes, separated by commas (e.g., fall_1_maths, spring_2_physics).
                </p>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={addStudentLoading}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg transition-all shadow-lg shadow-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addStudentLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5" />
                      Add Student
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddStudentModal(false);
                    setAddStudentMode('manual');
                  }}
                  className="px-6 py-3 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
            ) : (
              <form onSubmit={handleBulkStudentUpload} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-200 mb-2">
                    <FileSpreadsheet className="w-4 h-4 inline mr-2" />
                    Excel File (XLSX, XLS, or CSV)
                  </label>
                  <div className="border-2 border-dashed border-slate-700 rounded-lg p-8 text-center hover:border-cyan-500 transition-all">
                    {studentExcelFile ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-center gap-3 text-cyan-400">
                          <FileSpreadsheet className="w-12 h-12" />
                          <div className="text-left">
                            <p className="font-semibold text-white">{studentExcelFile.name}</p>
                            <p className="text-sm text-slate-400">
                              {(studentExcelFile.size / 1024).toFixed(2)} KB
                            </p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setStudentExcelFile(null)}
                          className="px-4 py-2 text-sm text-slate-400 hover:text-white hover:bg-slate-800/50 rounded-lg transition-all"
                        >
                          Change file
                        </button>
                      </div>
                    ) : (
                      <div>
                        <FileSpreadsheet className="w-12 h-12 text-slate-400 mx-auto mb-4" />
                        <label className="cursor-pointer">
                          <span className="text-cyan-400 hover:text-cyan-300 transition-colors">
                            Click to upload
                          </span>
                          <span className="text-slate-400"> or drag and drop</span>
                          <input
                            type="file"
                            onChange={handleStudentExcelChange}
                            accept=".xlsx,.xls,.csv"
                            className="hidden"
                            required
                          />
                        </label>
                        <p className="text-xs text-slate-400 mt-2">XLSX, XLS, or CSV up to 10MB</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-slate-800/30 rounded-lg p-4 border border-slate-700">
                  <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-cyan-400" />
                    Excel File Format
                  </h3>
                  <p className="text-xs text-slate-300 mb-2">
                    Your Excel file should contain the following columns (case insensitive):
                  </p>
                  <ul className="text-xs text-slate-400 space-y-1 ml-4">
                    <li>• Name or Student Name (required)</li>
                    <li>• Email</li>
                    <li>• Password</li>
                    <li>• University, College, or Institution</li>
                    <li>• Term (optional - will be prefixed to all subjects)</li>
                    <li>• Subject columns (e.g., fall_1_computers, fall_1_science, fall_2_computers, fall_2_english)</li>
                  </ul>
                  <p className="text-xs text-slate-500 mt-2">
                    Note: If you have a Term column with value "fall_1", it will be automatically prefixed to all subjects. Duplicate records are skipped, and existing records are updated with new subjects.
                  </p>
                </div>

                {bulkUploadSuccess && (
                  <div className="flex items-center gap-3 p-4 bg-green-500/10 border border-green-500/50 rounded-lg">
                    <Check className="w-5 h-5 text-green-400" />
                    <div className="text-sm text-green-400">
                      Successfully uploaded {uploadedRecordsCount} student record(s)!
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-4">
                  <button
                    type="submit"
                    disabled={addStudentLoading || !studentExcelFile}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg transition-all shadow-lg shadow-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {addStudentLoading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-5 h-5" />
                        Upload Students
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddStudentModal(false);
                      setAddStudentMode('manual');
                      setStudentExcelFile(null);
                    }}
                    className="px-6 py-3 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {showExportModal && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => setShowExportModal(false)}
        >
          <div
            className="relative max-w-2xl w-full backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-green-500 to-emerald-500 rounded-lg shadow-lg shadow-green-500/50">
                  <Download className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Export Student Records to Excel</h2>
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Building className="w-4 h-4 inline mr-2" />
                  Filter by University (Optional)
                </label>
                <select
                  value={exportFilters.university}
                  onChange={(e) => setExportFilters({ ...exportFilters, university: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">All Universities</option>
                  {uniqueUniversities.map((univ) => (
                    <option key={univ} value={univ}>{univ}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <Calendar className="w-4 h-4 inline mr-2" />
                    Start Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={exportFilters.startDate}
                    onChange={(e) => setExportFilters({ ...exportFilters, startDate: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <Calendar className="w-4 h-4 inline mr-2" />
                    End Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={exportFilters.endDate}
                    onChange={(e) => setExportFilters({ ...exportFilters, endDate: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="includeSubjects"
                  checked={exportFilters.includeSubjects}
                  onChange={(e) => setExportFilters({ ...exportFilters, includeSubjects: e.target.checked })}
                  className="w-4 h-4 text-green-500 bg-slate-800 border-slate-700 rounded focus:ring-green-500"
                />
                <label htmlFor="includeSubjects" className="text-sm text-slate-300">
                  Include Subjects Column
                </label>
              </div>

              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                <p className="text-sm text-slate-300">
                  <span className="font-semibold text-green-400">{getFilteredStudentsForExport().length}</span> student record(s) will be exported
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleExportToExcel}
                disabled={getFilteredStudentsForExport().length === 0 || exporting}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 disabled:from-slate-600 disabled:to-slate-700 disabled:cursor-not-allowed text-white rounded-lg transition-all shadow-lg shadow-green-500/50"
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  <>
                    <Download className="w-5 h-5" />
                    Export to Excel
                  </>
                )}
              </button>
              <button
                onClick={() => setShowExportModal(false)}
                className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditStudentModal && editingStudent && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={() => setShowEditStudentModal(false)}
        >
          <div
            className="relative max-w-2xl w-full backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-cyan-500 to-blue-500 rounded-lg shadow-lg shadow-cyan-500/50">
                  <Edit className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Edit Student</h2>
              </div>
              <button
                onClick={() => setShowEditStudentModal(false)}
                className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleEditStudent} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <User className="w-4 h-4 inline mr-2" />
                  Student Name *
                </label>
                <input
                  type="text"
                  value={editStudentData.student_name}
                  onChange={(e) => setEditStudentData({ ...editStudentData, student_name: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Enter student name"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Mail className="w-4 h-4 inline mr-2" />
                  Email
                </label>
                <input
                  type="email"
                  value={editStudentData.email}
                  onChange={(e) => setEditStudentData({ ...editStudentData, email: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="student@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Lock className="w-4 h-4 inline mr-2" />
                  Password
                </label>
                <input
                  type="text"
                  value={editStudentData.password}
                  onChange={(e) => setEditStudentData({ ...editStudentData, password: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Student password"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Hash className="w-4 h-4 inline mr-2" />
                  Phone Number
                </label>
                <input
                  type="text"
                  value={editStudentData.phone_number}
                  onChange={(e) => setEditStudentData({ ...editStudentData, phone_number: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="Phone number"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <Building className="w-4 h-4 inline mr-2" />
                  University
                </label>
                <input
                  type="text"
                  value={editStudentData.university}
                  onChange={(e) => setEditStudentData({ ...editStudentData, university: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="University name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <BookOpen className="w-4 h-4 inline mr-2" />
                  Subjects
                </label>
                <input
                  type="text"
                  value={editStudentData.subjects}
                  onChange={(e) => setEditStudentData({ ...editStudentData, subjects: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  placeholder="e.g., fall_1_maths, fall_1_physics, spring_2_chemistry"
                />
                <p className="text-xs text-slate-400 mt-2">
                  Enter subjects with term prefixes, separated by commas (e.g., fall_1_maths, spring_2_physics).
                </p>
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={editStudentLoading}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg transition-all shadow-lg shadow-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {editStudentLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Updating...
                    </>
                  ) : (
                    <>
                      <Edit className="w-5 h-5" />
                      Update Student
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setShowEditStudentModal(false)}
                  className="px-6 py-3 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedStudentForPopup && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-[9000]"
          onClick={() => { setSelectedStudentForPopup(null); setStudentReminderMessage(''); }}
        >
          <div
            className="backdrop-blur-xl bg-slate-900/90 border border-slate-700 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
              <div className="sticky top-0 bg-slate-900/95 backdrop-blur-xl border-b border-slate-700 p-6 flex justify-between items-center flex-wrap gap-3">
              <div>
                <h2 className="text-2xl font-bold text-white mb-1">Student Details</h2>
                <p className="text-slate-400 text-sm">{selectedStudentForPopup.student_name}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={async () => {
                    if (!selectedStudentForPopup?.email?.trim()) {
                      setStudentReminderMessage('Student has no email');
                      return;
                    }
                    setStudentReminderMessage('');
                    setStudentReminderSending(true);
                    try {
                      const { data: { session } } = await supabase.auth.getSession();
                      if (!session?.access_token) {
                        setStudentReminderMessage('Not signed in');
                        setStudentReminderSending(false);
                        return;
                      }
                      if (!isReminderApiConfigured()) {
                        setStudentReminderMessage('Reminder server not configured (set VITE_REMINDER_API_URL)');
                        setStudentReminderSending(false);
                        return;
                      }
                      const res = await fetch(REMINDER_API_URLS.sendReminderToStudent, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ student_id: selectedStudentForPopup.id }),
                      });
                      const data = await res.json().catch(() => ({}));
                      if (!res.ok) {
                        setStudentReminderMessage(data?.error || 'Failed to send reminder');
                      } else {
                        setStudentReminderMessage('Reminder sent');
                      }
                    } catch (e) {
                      setStudentReminderMessage(
                        isReminderFetchNetworkError(e) ? reminderApiNetworkErrorHint() : (e instanceof Error ? e.message : 'Request failed')
                      );
                    } finally {
                      setStudentReminderSending(false);
                    }
                  }}
                  disabled={studentReminderSending || !selectedStudentForPopup?.email?.trim()}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm transition-colors"
                >
                  {studentReminderSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                  {studentReminderSending ? 'Sending…' : 'Send reminder'}
                </button>
                {studentReminderMessage && (
                  <span className="text-sm text-slate-300">{studentReminderMessage}</span>
                )}
                <button
                  onClick={() => { setSelectedStudentForPopup(null); setStudentReminderMessage(''); }}
                  className="text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Mail className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-slate-400 uppercase">Email</span>
                  </div>
                  <p className="text-white">{selectedStudentForPopup.email || 'Not provided'}</p>
                </div>

                <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Lock className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-slate-400 uppercase">Password</span>
                  </div>
                  <p className="text-white font-mono">{selectedStudentForPopup.password || 'Not provided'}</p>
                </div>

                <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 p-4 md:col-span-2">
                  <div className="flex items-center gap-2 mb-2">
                    <Building className="w-4 h-4 text-cyan-400" />
                    <span className="text-xs font-semibold text-slate-400 uppercase">University</span>
                  </div>
                  <p className="text-white">{selectedStudentForPopup.university || 'Not provided'}</p>
                </div>
              </div>

              <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 overflow-hidden">
                <div className="bg-slate-900/50 border-b border-slate-700 p-4">
                  <div className="flex items-center gap-2">
                    <GraduationCap className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-lg font-bold text-white">Subjects</h3>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-900/30 border-b border-slate-700">
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">#</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Subject</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider w-20">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedStudentForPopup.subjects ? (
                        selectedStudentForPopup.subjects.split(',').map((subject, index) => {
                          const subTrim = subject.trim();
                          const subLower = subTrim.toLowerCase();
                          const paymentsForSubject = studentPayments.filter((p) =>
                            (p.subjects || '').split(',').map((s) => s.trim().toLowerCase()).includes(subLower)
                          );
                          const hasPaidCompletely = paymentsForSubject.some((p) => p.payment_status === 'paid_completely');
                          const hasPartially = paymentsForSubject.some((p) => p.payment_status === 'paid_partially');
                          const status = hasPaidCompletely ? 'paid' : hasPartially ? 'partial' : 'pending';
                          return (
                            <tr key={index} className="border-b border-slate-700/50 hover:bg-slate-800/50 transition-colors">
                              <td className="px-4 py-3 text-slate-300">{index + 1}</td>
                              <td className="px-4 py-3 text-white font-medium">{subTrim}</td>
                              <td className="px-4 py-3">
                                {status === 'paid' ? (
                                  <span className="inline-flex items-center text-green-400" title="Paid completely">
                                    <Check className="w-5 h-5" />
                                  </span>
                                ) : status === 'partial' ? (
                                  <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-amber-500/30 text-amber-400 font-bold text-sm" title="Partially paid">
                                    P
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center text-red-400" title="Pending">
                                    <X className="w-5 h-5" />
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={3} className="px-4 py-8 text-center text-slate-400">
                            No subjects available
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 overflow-hidden">
                <div className="bg-slate-900/50 border-b border-slate-700 p-4">
                  <div className="flex items-center gap-2">
                    <ImageIcon className="w-5 h-5 text-cyan-400" />
                    <h3 className="text-lg font-bold text-white">Payment Screenshots</h3>
                  </div>
                </div>
                <div className="p-4">
                  {(() => {
                    const allScreenshots: { url: string; label?: string }[] = [];
                    studentPayments.forEach((p) => {
                      const urls = (p.payment_screenshot_urls && p.payment_screenshot_urls.length > 0)
                        ? p.payment_screenshot_urls
                        : (p.payment_screenshot_url ? [p.payment_screenshot_url] : []);
                      const label = p.subjects ? `${p.subjects} • ${p.payment_status}` : p.payment_status;
                      urls.forEach((url) => allScreenshots.push({ url, label }));
                    });
                    return allScreenshots.length > 0 ? (
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                        {allScreenshots.map(({ url, label }, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              setSelectedImages(allScreenshots.map((s) => s.url));
                              setSelectedImageIndex(idx);
                            }}
                            className="relative aspect-square rounded-lg overflow-hidden border-2 border-slate-600 hover:border-cyan-500/50 transition-all group"
                          >
                            <img
                              src={url}
                              alt={label || `Screenshot ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Eye className="w-8 h-8 text-white" />
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-400 text-sm py-4">No payment screenshots uploaded yet</p>
                    );
                  })()}
                </div>
              </div>

              <div className="backdrop-blur-xl bg-slate-800/30 rounded-lg border border-slate-700 overflow-hidden">
                <div className="bg-slate-900/50 border-b border-slate-700 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-5 h-5 text-cyan-400" />
                      <h3 className="text-lg font-bold text-white">Payment History</h3>
                    </div>
                    <button
                      onClick={() => setShowAddPaymentModal(true)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-lg text-sm transition-all shadow-lg shadow-green-500/50"
                    >
                      <Plus className="w-4 h-4" />
                      Add Payment
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  {studentPaymentsLoading ? (
                    <div className="flex justify-center items-center py-8">
                      <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                    </div>
                  ) : studentPayments.length > 0 ? (
                    <table className="w-full">
                      <thead>
                        <tr className="bg-slate-900/30 border-b border-slate-700">
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Payment Date</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Payment Mode</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Amount</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Balance</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Subject(s)</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Credited To</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Screenshot</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {studentPayments.map((payment) => (
                          <tr key={payment.id} className="border-b border-slate-700/50 hover:bg-slate-800/50 transition-colors">
                            <td className="px-4 py-3 text-slate-300">
                              {payment.payment_date
                                ? new Date(payment.payment_date).toLocaleDateString()
                                : new Date(payment.created_at).toLocaleDateString()
                              }
                            </td>
                            <td className="px-4 py-3 text-white font-medium">{payment.payment_mode}</td>
                            <td className="px-4 py-3 text-white">
                              {formatCurrency(payment.amount, payment.currency)}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                payment.payment_status === 'paid_completely'
                                  ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                                  : payment.payment_status === 'paid_partially'
                                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50'
                                  : 'bg-red-500/20 text-red-400 border border-red-500/50'
                              }`}>
                                {payment.payment_status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-white">
                              {formatCurrency(payment.balance_amount, payment.currency)}
                            </td>
                            <td className="px-4 py-3 text-slate-300">
                              {payment.subjects?.trim() || '—'}
                            </td>
                            <td className="px-4 py-3 text-slate-300">
                              {payment.credited_to || '-'}
                            </td>
                            <td className="px-4 py-3">
                              {(() => {
                                const urls = (payment.payment_screenshot_urls && payment.payment_screenshot_urls.length > 0)
                                  ? payment.payment_screenshot_urls
                                  : (payment.payment_screenshot_url ? [payment.payment_screenshot_url] : []);
                                return urls.length > 0 ? (
                                  <button
                                    onClick={() => {
                                      setSelectedImages(urls);
                                      setSelectedImageIndex(0);
                                    }}
                                    className="px-3 py-1 text-xs bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 rounded hover:bg-cyan-500/30 transition-all"
                                  >
                                    View
                                  </button>
                                ) : (
                                  <span className="text-slate-500 text-xs">No screenshot</span>
                                );
                              })()}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => handleEditPaymentOpen(payment)}
                                  className="px-3 py-1 text-xs bg-amber-500/20 text-amber-400 border border-amber-500/50 rounded hover:bg-amber-500/30 transition-all"
                                >
                                  <Edit className="w-4 h-4 inline" />
                                </button>
                                <button
                                  onClick={() => handleDeletePayment(payment.id)}
                                  className="px-3 py-1 text-xs bg-red-500/20 text-red-400 border border-red-500/50 rounded hover:bg-red-500/30 transition-all"
                                >
                                  <Trash2 className="w-4 h-4 inline" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="px-4 py-8 text-center text-slate-400">
                      No payment records found
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAddPaymentModal && selectedStudentForPopup && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-[9100] overflow-y-auto"
          onClick={() => { setShowAddPaymentModal(false); setError(''); setAddPaymentScreenshot(null); setAddPaymentScreenshotPreview(''); }}
        >
          <div
            className="relative max-w-2xl w-full max-h-[90vh] backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 flex flex-col my-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center justify-between p-6 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-green-500 to-emerald-500 rounded-lg shadow-lg shadow-green-500/50">
                  <Plus className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Add Payment</h2>
              </div>
              <button
                type="button"
                onClick={() => { setShowAddPaymentModal(false); setError(''); setAddPaymentScreenshot(null); setAddPaymentScreenshotPreview(''); }}
                className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 min-h-0 p-6">
            <form onSubmit={handleAddPayment} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <CreditCard className="w-4 h-4 inline mr-2" />
                    Payment Mode *
                  </label>
                  <select
                    value={newPaymentData.payment_mode}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, payment_mode: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    required
                  >
                    <option value="">Select payment mode</option>
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <DollarSign className="w-4 h-4 inline mr-2" />
                    Currency *
                  </label>
                  <select
                    value={newPaymentData.currency}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, currency: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    required
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency} value={currency}>{currency}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <DollarSign className="w-4 h-4 inline mr-2" />
                    Amount *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={newPaymentData.amount}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, amount: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="0.00"
                    required
                    min="0"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <DollarSign className="w-4 h-4 inline mr-2" />
                    Balance Amount *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    value={newPaymentData.balance_amount}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, balance_amount: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="0.00"
                    required
                    min="0"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <CreditCard className="w-4 h-4 inline mr-2" />
                  Payment Status *
                </label>
                <select
                  value={newPaymentData.payment_status}
                  onChange={(e) => setNewPaymentData({ ...newPaymentData, payment_status: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  required
                >
                  {PAYMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <Calendar className="w-4 h-4 inline mr-2" />
                    Payment Date
                  </label>
                  <input
                    type="date"
                    value={newPaymentData.payment_date}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, payment_date: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    <User className="w-4 h-4 inline mr-2" />
                    Credited To
                  </label>
                  <input
                    type="text"
                    value={newPaymentData.credited_to}
                    onChange={(e) => setNewPaymentData({ ...newPaymentData, credited_to: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Account name or reference"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <ImageIcon className="w-4 h-4 inline mr-2" />
                  Upload Screenshot
                </label>
                {addPaymentScreenshotPreview ? (
                  <div className="relative border-2 border-slate-700 rounded-lg p-4">
                    <img
                      src={addPaymentScreenshotPreview}
                      alt="Payment screenshot preview"
                      className="max-h-48 mx-auto rounded"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setAddPaymentScreenshot(null);
                        setAddPaymentScreenshotPreview('');
                      }}
                      className="absolute top-2 right-2 p-2 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-slate-700 rounded-lg p-6 text-center hover:border-green-500/50 transition-all">
                    <ImageIcon className="w-10 h-10 text-slate-400 mx-auto mb-2" />
                    <label className="cursor-pointer">
                      <span className="text-green-400 hover:text-green-300 transition-colors">Click to upload</span>
                      <span className="text-slate-400"> or drag and drop (max 5MB)</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 5 * 1024 * 1024) {
                              setError('File size must be less than 5MB');
                              return;
                            }
                            if (!file.type.startsWith('image/')) {
                              setError('Please upload an image file');
                              return;
                            }
                            setAddPaymentScreenshot(file);
                            setAddPaymentScreenshotPreview(URL.createObjectURL(file));
                            setError('');
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  <BookOpen className="w-4 h-4 inline mr-2" />
                  Subject(s) for this payment
                </label>
                <input
                  type="text"
                  value={newPaymentData.subjects}
                  onChange={(e) => setNewPaymentData({ ...newPaymentData, subjects: e.target.value })}
                  className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="e.g. Math, Physics (comma-separated)"
                />
                {selectedStudentForPopup?.subjects && (
                  <p className="text-xs text-slate-500 mt-1">Student&apos;s subjects: {selectedStudentForPopup.subjects}</p>
                )}
                <p className="text-xs text-slate-500 mt-1">Optional — if provided, we replace any existing pending or partial payment for these subjects with this new payment.</p>
              </div>

              {error && (
                <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">
                  {error}
                </div>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={addPaymentLoading}
                  className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white rounded-lg transition-all shadow-lg shadow-green-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {addPaymentLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Plus className="w-5 h-5" />
                      Add Payment
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddPaymentModal(false);
                    setError('');
                    setAddPaymentScreenshot(null);
                    setAddPaymentScreenshotPreview('');
                  }}
                  className="px-6 py-3 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700"
                >
                  Cancel
                </button>
              </div>
            </form>
            </div>
          </div>
        </div>
      )}

      {showEditPaymentModal && editingPayment && selectedStudentForPopup && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-[9100] overflow-y-auto"
          onClick={handleEditPaymentClose}
        >
          <div
            className="relative max-w-2xl w-full max-h-[90vh] backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 flex flex-col my-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center justify-between p-6 border-b border-slate-700">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-gradient-to-br from-amber-500 to-orange-500 rounded-lg shadow-lg shadow-amber-500/50">
                  <Edit className="w-5 h-5 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-white">Edit Payment</h2>
              </div>
              <button type="button" onClick={handleEditPaymentClose} className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 min-h-0 p-6">
              <form onSubmit={handleUpdatePayment} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Payment Mode *</label>
                    <select
                      value={editPaymentData.payment_mode}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, payment_mode: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    >
                      <option value="">Select</option>
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Currency *</label>
                    <select
                      value={editPaymentData.currency}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, currency: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    >
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Amount *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editPaymentData.amount}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, amount: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Balance Amount *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editPaymentData.balance_amount}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, balance_amount: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Payment Status *</label>
                  <select
                    value={editPaymentData.payment_status}
                    onChange={(e) => setEditPaymentData({ ...editPaymentData, payment_status: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    required
                  >
                    {PAYMENT_STATUSES.map((s) => (
                      <option key={s} value={s}>{s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Payment Date</label>
                    <input
                      type="date"
                      value={editPaymentData.payment_date}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, payment_date: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-2">Credited To</label>
                    <input
                      type="text"
                      value={editPaymentData.credited_to}
                      onChange={(e) => setEditPaymentData({ ...editPaymentData, credited_to: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                      placeholder="Account name or reference"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Subject(s)</label>
                  <input
                    type="text"
                    value={editPaymentData.subjects}
                    onChange={(e) => setEditPaymentData({ ...editPaymentData, subjects: e.target.value })}
                    className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
                    placeholder="e.g. Math, Physics (comma-separated)"
                  />
                </div>
                {error && (
                  <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 text-sm">{error}</div>
                )}
                <div className="flex gap-3 pt-4">
                  <button
                    type="submit"
                    disabled={editPaymentLoading}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-lg transition-all shadow-lg shadow-amber-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {editPaymentLoading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Edit className="w-5 h-5" />
                        Save Changes
                      </>
                    )}
                  </button>
                  <button type="button" onClick={handleEditPaymentClose} className="px-6 py-3 bg-slate-800/50 hover:bg-slate-800 text-white rounded-lg transition-all border border-slate-700">
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {selectedExcelFile && (
        <div
          className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 z-[9600]"
          onClick={() => setSelectedExcelFile(null)}
        >
          <div
            className="relative max-w-6xl w-full max-h-[90vh] backdrop-blur-xl bg-slate-900/90 rounded-2xl shadow-2xl border border-white/20 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-slate-900/95 backdrop-blur-xl border-b border-slate-700 p-6 flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-white mb-1">Excel File Preview</h2>
                <p className="text-slate-400 text-sm">{selectedExcelFile.file_name}</p>
              </div>
              <button
                onClick={() => setSelectedExcelFile(null)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
              {excelPreviewLoading ? (
                <div className="flex justify-center items-center py-12">
                  <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                </div>
              ) : excelPreviewData.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-900/30 border-b border-slate-700">
                        {Object.keys(excelPreviewData[0]).map((key) => (
                          <th key={key} className="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider">
                            {key}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {excelPreviewData.map((row, idx) => (
                        <tr key={idx} className="border-b border-slate-700/50 hover:bg-slate-800/50 transition-colors">
                          {Object.keys(excelPreviewData[0]).map((key) => (
                            <td key={key} className="px-4 py-3 text-slate-300">
                              {String(row[key] || '-')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 text-slate-400">
                  No data to display
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
