import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { resolveCatalogEgress, catalogFetch } from "@/lib/network/catalogEgress.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");
  const provider = searchParams.get("provider");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  try {
    // When the dashboard names the provider, the catalog fetch follows the
    // provider's egress pool (providerStrategies.<provider>.proxyPoolId) so it
    // works on hosts with fail-closed outbound firewalls. Without the param
    // the fetch stays direct, exactly as before.
    const proxyOptions = provider ? await resolveCatalogEgress(provider) : null;
    const res = await catalogFetch(url, {}, proxyOptions);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
