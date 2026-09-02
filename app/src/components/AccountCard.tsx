"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { LatencyBadge } from "./LatencyBadge";

interface Account {
  ACCOUNT_ID: string | number;
  ACCOUNT_TYPE: string;
  BALANCE: string | number;
  STATUS: string;
  CUSTOMER_NAME?: string;
  FIRST_NAME?: string;
  LAST_NAME?: string;
  EMAIL?: string;
  PHONE?: string;
  HT_WRITE_MS?: number | null;
  UPDATED_AT?: string;
  SOURCE_UPDATED_AT?: string;
}

interface Txn {
  TXN_ID: number;
  TXN_TYPE: string;
  AMOUNT: number;
  MERCHANT: string;
  DESCRIPTION?: string;
  TXN_TS: string;
  SLA_MS?: number | null;
}

interface Props {
  accountId: string;
}

const TXN_COLORS: Record<string, string> = {
  DEPOSIT:      "bg-emerald-100 text-emerald-700",
  TRANSFER_IN:  "bg-emerald-100 text-emerald-700",
  DEBIT:        "bg-rose-100    text-rose-700",
  WITHDRAWAL:   "bg-rose-100    text-rose-700",
  TRANSFER_OUT: "bg-orange-100  text-orange-700",
  FEE:          "bg-slate-100   text-slate-600",
  INTEREST:     "bg-blue-100    text-blue-700",
};

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export default function AccountCard({ accountId }: Props) {
  const [account,      setAccount]      = useState<Account | null>(null);
  const [transactions, setTransactions] = useState<Txn[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [refreshedAt,  setRefreshedAt]  = useState<number>(0);

  const load = async () => {
    try {
      const res = await fetch(`/api/accounts/${accountId}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { account: acct, transactions: txns } = await res.json();
      setAccount(acct);
      setTransactions(txns ?? []);
      setRefreshedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [accountId]);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
        Loading account…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl border border-red-200 p-10 text-center">
        <p className="text-red-600 font-medium">{error}</p>
        <button onClick={load} className="mt-4 text-sm text-bank-sky underline">
          Retry
        </button>
      </div>
    );
  }

  if (!account) return null;

  const balance = parseFloat(String(account.BALANCE)).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });

  return (
    <div className="space-y-6">
      {/* Account summary card */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        {/* Customer name */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Account Holder</p>
            <h2 className="text-2xl font-bold text-bank-navy">
              {account.CUSTOMER_NAME ?? `${account.FIRST_NAME} ${account.LAST_NAME}`}
            </h2>
            {account.EMAIL && (
              <p className="text-sm text-slate-500 mt-0.5">{account.EMAIL}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400 mb-1">ACC-{String(account.ACCOUNT_ID).padStart(4, "0")}</p>
            <span
              className={clsx(
                "px-2.5 py-1 rounded-full text-xs font-semibold",
                account.STATUS === "ACTIVE"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-red-100 text-red-700"
              )}
            >
              ● {account.STATUS}
            </span>
          </div>
        </div>

        <div className="h-px bg-slate-100 mb-5" />

        {/* Balance */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Current Balance</p>
            <p className="text-3xl font-bold text-bank-navy">{balance}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-slate-500">From Hybrid Table</span>
              {account.HT_WRITE_MS !== null && account.HT_WRITE_MS !== undefined && (
                <LatencyBadge ms={account.HT_WRITE_MS} />
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Account Type</p>
            <p className="text-lg font-semibold text-slate-700">{account.ACCOUNT_TYPE}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Balance Updated</p>
            <p className="text-sm font-medium text-slate-700">
              {timeAgo(account.UPDATED_AT)}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              Refreshed {Math.round((Date.now() - refreshedAt) / 1000)}s ago
            </p>
          </div>
        </div>

        {/* Unistore badge */}
        <div className="mt-5 inline-flex items-center gap-2 bg-bank-light border border-bank-sky/30 rounded-lg px-3 py-2">
          <svg className="w-4 h-4 text-bank-sky" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
          </svg>
          <span className="text-xs font-medium text-bank-blue">
            Unistore query — Hybrid Table (live balance) + Standard Table (full history) joined in one SQL statement
          </span>
        </div>
      </div>

      {/* Transaction history */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="font-semibold text-slate-800">Recent Activity</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Last 20 transactions from <code className="bg-slate-100 px-1 rounded">transactions_landing</code>
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-5 py-3 text-left font-medium">Type</th>
                <th className="px-5 py-3 text-right font-medium">Amount</th>
                <th className="px-5 py-3 text-left font-medium">Merchant</th>
                <th className="px-5 py-3 text-left font-medium">Time</th>
                <th className="px-5 py-3 text-left font-medium">SLA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transactions.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-slate-400">
                    No transactions found for this account.
                  </td>
                </tr>
              )}
              {transactions.map((txn) => (
                <tr key={txn.TXN_ID} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <span
                      className={clsx(
                        "px-2 py-0.5 rounded text-xs font-semibold",
                        TXN_COLORS[txn.TXN_TYPE] ?? "bg-slate-100 text-slate-600"
                      )}
                    >
                      {txn.TXN_TYPE}
                    </span>
                  </td>
                  <td
                    className={clsx(
                      "px-5 py-3 text-right font-semibold",
                      txn.AMOUNT >= 0 ? "text-emerald-600" : "text-rose-600"
                    )}
                  >
                    {txn.AMOUNT >= 0 ? "+" : ""}
                    {txn.AMOUNT.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </td>
                  <td className="px-5 py-3 text-slate-600 max-w-[200px] truncate">
                    {txn.MERCHANT}
                  </td>
                  <td className="px-5 py-3 text-slate-400 text-xs whitespace-nowrap">
                    {timeAgo(txn.TXN_TS)}
                  </td>
                  <td className="px-5 py-3">
                    <LatencyBadge ms={txn.SLA_MS} quiet />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
