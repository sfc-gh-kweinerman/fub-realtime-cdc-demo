import Link from "next/link";
import AccountCard from "@/components/AccountCard";

export const revalidate = 0;

export default function AccountPage({
  params,
}: {
  params: { id: string };
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-sm text-bank-sky hover:underline flex items-center gap-1"
        >
          ← Back to Feed
        </Link>
        <span className="text-slate-300">|</span>
        <span className="text-sm text-slate-500">
          Account{" "}
          <span className="font-mono font-semibold text-slate-700">
            ACC-{params.id.padStart(4, "0")}
          </span>
        </span>
      </div>

      <AccountCard accountId={params.id} />
    </div>
  );
}
