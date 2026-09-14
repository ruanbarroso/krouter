import { NextResponse } from "next/server";
import { getModelAliases, setModelAlias, deleteModelAlias } from "@/models";
import { enableModels } from "@/lib/disabledModelsDb";

export const dynamic = "force-dynamic";

// GET /api/models/alias - Get all aliases
export async function GET() {
  try {
    const aliases = await getModelAliases();
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT(request) {
  try {
    const body = await request.json();
    const { model, alias } = body;

    if (!model || !alias) {
      return NextResponse.json({ error: "Model and alias required" }, { status: 400 });
    }

    await setModelAlias(alias, model);

    // Adding a model is an explicit enable: a hardcoded model that was
    // previously disabled via the X button stays in disabledModels and would
    // otherwise remain invisible (filtered from displayModels and excluded
    // from the custom list as "already hardcoded"). Clear it so the + button
    // actually restores the model.
    try {
      const slash = String(model).indexOf("/");
      if (slash > 0) {
        const providerAlias = String(model).slice(0, slash);
        const modelId = String(model).slice(slash + 1);
        if (providerAlias && modelId) await enableModels(providerAlias, [modelId]);
      }
    } catch { /* enable is best-effort; alias already saved */ }

    try {
      const { invalidateModelsCache } = await import("@/app/api/v1/models/route.js");
      invalidateModelsCache?.();
    } catch { /* cache TTL covers it */ }

    return NextResponse.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return NextResponse.json({ error: "Failed to update alias" }, { status: 500 });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const alias = searchParams.get("alias");

    if (!alias) {
      return NextResponse.json({ error: "Alias required" }, { status: 400 });
    }

    await deleteModelAlias(alias);

    try {
      const { invalidateModelsCache } = await import("@/app/api/v1/models/route.js");
      invalidateModelsCache?.();
    } catch { /* cache TTL covers it */ }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return NextResponse.json({ error: "Failed to delete alias" }, { status: 500 });
  }
}
