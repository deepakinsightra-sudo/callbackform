const TRAINING = "Training & Education";
const BROKING = "Stock Broking & Investments";

const RETRY =
  "We could not send your response. Please try again in a moment.";

function businessUnitForServices(services, fallback = BROKING) {
  if (
    /\b(courses?|training|education|learn(?:ing)?|workshops?|seminars?)\b/i.test(
      services
    )
  ) {
    return TRAINING;
  }

  if (
    /\b(stocks?|broking|demat|trading|investments?|insurance|retirement|mutual\s+funds?|securities|pension|wealth|pms|aif|bonds?|loans?)\b/i.test(
      services
    )
  ) {
    return BROKING;
  }

  return fallback;
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

async function saveToGoogleSheet({ name, phone, services }) {
  const endpoint =
    process.env.GOOGLE_SHEETS_WEBHOOK_URL ||
    process.env.GOOGLE_APPS_SCRIPT_URL;

  if (!endpoint) {
    console.error("Sheet fallback unavailable", {
      reason: "missing_google_sheet_url",
    });

    return false;
  }

  try {
    console.info("Google Sheet fallback attempt", {
      endpoint_present: true,
    });

    const response = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        name,
        phone,
        services,
        "bot-field": "",
      }).toString(),

      signal: AbortSignal.timeout(10000),

      redirect: "follow",
    });

    const body = await response.text().catch(() => "");

    console.info("Google Sheet fallback response", {
      status: response.status,
      ok: response.ok,
      body_preview: body.slice(0, 200),
    });

    if (!response.ok) {
      console.error("Sheet fallback HTTP error", {
        status: response.status,
      });

      return false;
    }

    if (body.trim().toLowerCase() === "invalid") {
      console.error("Sheet fallback rejected by Apps Script");

      return false;
    }

    console.info("Sheet fallback succeeded");

    return true;
  } catch (error) {
    console.error("Sheet fallback connection failed", {
      name: error?.name || "UnknownError",
      message: error?.message || "Unknown error",
    });

    return false;
  }
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return reply(405, {
      success: false,
      message: RETRY,
    });
  }

  try {
    const contentType = Object.entries(event.headers || {}).find(
      ([key]) => key.toLowerCase() === "content-type"
    )?.[1];

    if (
      contentType?.split(";")[0]?.trim()?.toLowerCase() !==
      "application/json"
    ) {
      return reply(415, {
        success: false,
        message: RETRY,
      });
    }

    const body = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";

    let input;

    try {
      input = JSON.parse(body);
    } catch {
      return reply(400, {
        success: false,
        message: RETRY,
      });
    }

    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply(400, {
        success: false,
        message: RETRY,
      });
    }

    if (input["bot-field"]) {
      return reply(200, {
        success: true,
        message: "Your response has been sent.",
      });
    }

    const name =
      typeof input.name === "string"
        ? input.name.trim()
        : "";

    const phone =
      typeof input.phone === "string"
        ? input.phone.trim()
        : "";

    const services =
      typeof input.services === "string"
        ? input.services.trim()
        : "";

    if (
      name.length < 2 ||
      services.length < 3
    ) {
      return reply(400, {
        success: false,
        message:
          "Please check your name and service details and try again.",
      });
    }

    let digits = phone.replace(/\D/g, "");

    if (digits.startsWith("00")) {
      digits = digits.slice(2);
    }

    if (
      digits.length === 13 &&
      digits.startsWith("910")
    ) {
      digits = digits.slice(3);
    }

    if (
      digits.length === 12 &&
      digits.startsWith("91")
    ) {
      digits = digits.slice(2);
    }

    if (
      digits.length === 11 &&
      digits.startsWith("0")
    ) {
      digits = digits.slice(1);
    }

    if (!/^\d{10,15}$/.test(digits)) {
      return reply(400, {
        success: false,
        message: "Please enter a valid phone number.",
      });
    }

    const crmEndpoint =
      process.env.CRM_WEBHOOK_URL;

    const crmSecret =
      process.env.CRM_WEBHOOK_SECRET;

    const fallbackBusinessUnit =
      process.env.CALLBACK_DEFAULT_BUSINESS_UNIT ||
      BROKING;

    let crmSaved = false;

    /*
     * FIRST: TRY CRM
     */

    if (crmEndpoint && crmSecret) {
      try {
        console.info("CRM webhook attempt", {
          endpoint_present: true,
          secret_present: true,
          business_unit: businessUnitForServices(
            services,
            fallbackBusinessUnit
          ),
        });

        const payload = {
          full_name: name,

          mobile: phone,

          email: null,

          business_unit:
            businessUnitForServices(
              services,
              fallbackBusinessUnit
            ),

          source: "Callback Form",

          campaign_name: null,

          product_interest: services,

          lead_grade: null,

          notes: null,
        };

        const crmResponse = await fetch(crmEndpoint, {
          method: "POST",

          headers: {
            "Content-Type": "application/json",

            "x-webhook-secret": crmSecret,
          },

          body: JSON.stringify(payload),

          signal: AbortSignal.timeout(15000),

          redirect: "follow",
        });

        const crmBody =
          await crmResponse.text().catch(() => "");

        console.info("CRM webhook response", {
          status: crmResponse.status,
          ok: crmResponse.ok,
          body_preview: crmBody.slice(0, 300),
        });

        if (crmResponse.ok) {
          let result = {};

          try {
            result = JSON.parse(crmBody);
          } catch {
            result = {};
          }

          if (
            ["created", "duplicate"].includes(
              result?.status
            )
          ) {
            crmSaved = true;

            console.info("CRM lead accepted", {
              status: result.status,
            });
          } else {
            console.error("CRM response invalid", {
              status: crmResponse.status,
              body_preview: crmBody.slice(0, 300),
            });
          }
        } else {
          console.error("CRM returned error", {
            status: crmResponse.status,
            body_preview: crmBody.slice(0, 300),
          });
        }
      } catch (error) {
        console.error("CRM webhook fetch failed", {
          name: error?.name || "UnknownError",
          message: error?.message || "Unknown error",
        });
      }
    } else {
      console.error("CRM configuration missing", {
        endpoint_present: Boolean(crmEndpoint),
        secret_present: Boolean(crmSecret),
      });
    }

    /*
     * CRM SUCCESS
     *
     * CRM itself is responsible for:
     * Supabase storage
     * allocation
     * Google Sheet mirror
     */

    if (crmSaved) {
      return reply(200, {
        success: true,

        message:
          "Your response has been sent. Our team will get back to you.",

        destination: "crm",
      });
    }

    /*
     * CRM FAILED
     *
     * FALLBACK:
     * Save directly to Google Sheet so lead is not lost.
     */

    console.warn(
      "CRM failed. Attempting Google Sheet fallback."
    );

    const sheetSaved =
      await saveToGoogleSheet({
        name,
        phone,
        services,
      });

    /*
     * SHEET SUCCESS
     *
     * Lead is preserved even though CRM failed.
     */

    if (sheetSaved) {
      return reply(200, {
        success: true,

        message:
          "Your response has been sent. Our team will get back to you.",

        destination:
          "google_sheet_fallback",
      });
    }

    /*
     * BOTH CRM AND SHEET FAILED
     */

    console.error(
      "Lead submission failed in both CRM and Google Sheet"
    );

    return reply(502, {
      success: false,
      message: RETRY,
    });
  } catch (error) {
    console.error("Unexpected callback failure", {
      name: error?.name || "UnknownError",
      message: error?.message || "Unknown error",
    });

    return reply(502, {
      success: false,
      message: RETRY,
    });
  }
}
