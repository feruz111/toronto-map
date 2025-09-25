import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET() {
    const startTime = Date.now();
    const client = await pool.connect();

    try {
        await client.query("SELECT 1");
        const dbTimeMs = Date.now() - startTime;

        return NextResponse.json({
            ok: true,
            dbTimeMs
        });
    } catch (error) {
        console.error("[db] Health check failed:", error);
        return NextResponse.json({
            ok: false,
            error: "Database connection failed"
        }, { status: 500 });
    } finally {
        client.release();
    }
}
