import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_PLACES_API_KEY" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const ref = (searchParams.get("ref") ?? "").trim();
    const mwRaw = (searchParams.get("mw") ?? "1200").trim();
    const mw = Math.max(200, Math.min(2000, Number(mwRaw) || 1200));

    if (!ref) {
      return NextResponse.json({ ok: false, error: "Missing ref" }, { status: 400 });
    }

    const googleUrl =
      `https://maps.googleapis.com/maps/api/place/photo` +
      `?maxwidth=${mw}` +
      `&photo_reference=${encodeURIComponent(ref)}` +
      `&key=${key}`;

    const upstream = await fetch(googleUrl, { cache: "no-store" });
    if (!upstream.ok) {
      return NextResponse.json({ ok: false, error: "Photo fetch failed" }, { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buf = await upstream.arrayBuffer();

    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=86400, s-maxage=86400",
      },
    });
  } catch (e) {
    console.error("PHOTO ERROR:", e);
    return NextResponse.json({ ok: false, error: "Photo proxy failed" }, { status: 500 });
  }
}