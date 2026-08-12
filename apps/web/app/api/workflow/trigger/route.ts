import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const response = await fetch(
      "http://localhost:4001/actions/trigger-workflow-run",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    return NextResponse.json(data, {
      status: response.status,
    });
  } catch (error) {
    console.error("Workflow trigger error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Workflow engine is unavailable",
      },
      { status: 500 }
    );
  }
}