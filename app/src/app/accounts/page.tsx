import { redirect } from "next/navigation";

// /accounts?id=1001 → redirect to /accounts/1001
export default function AccountsRedirect({
  searchParams,
}: {
  searchParams: { id?: string };
}) {
  const id = searchParams.id;
  if (id) redirect(`/accounts/${id}`);
  redirect("/");
}
