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

    if (!response.ok) {
      console.error("Sheet fallback failed", {
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
  } catch {
    console.error("Sheet fallback connection failed");

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

    if (!input || typeof input !== "object") {
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
        message: "Please check your details and try again.",
      });
    }

    let digits =
      phone.replace(/\D/g, "");

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
     * FIRST: Try CRM
     */

    if (crmEndpoint && crmSecret) {
      try {
        const payload = {
          full_name: name,

          mobile: phone,

          email: null,

          business_unit:
            businessUnitForServices(
              services,
              fallbackBusinessUnit
            ),

          source:
            "Callback Form",

          campaign_name:
            null,

          product_interest:
            services,

          lead_grade:
            null,

          notes:
            null,
        };

        const crmResponse =
          await fetch(crmEndpoint, {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-webhook-secret":
                crmSecret,
            },

            body:
              JSON.stringify(payload),

            signal:
              AbortSignal.timeout(
                15000
              ),
          });

        console.info(
          "CRM webhook response",
          {
            status:
              crmResponse.status,
          }
        );

        if (crmResponse.ok) {
          const result =
            await crmResponse.json();

          if (
            ["created", "duplicate"].includes(
              result?.status
            )
          ) {
            crmSaved = true;
          }
        }
      } catch {
        console.error(
          "CRM webhook failed"
        );
      }
    } else {
      console.error(
        "CRM configuration missing"
      );
    }

    /*
     * CRM SUCCESS
     *
     * CRM already handles Google
     * Sheet sync internally.
     */

    if (crmSaved) {
      return reply(200, {
        success: true,

        message:
          "Your response has been sent. Our team will get back to you.",

        destination:
          "crm",
      });
    }

    /*
     * CRM FAILED
     *
     * CRITICAL FALLBACK:
     * Do not lose the lead.
     *
     * Save directly to Google Sheet.
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
     * Sheet saved successfully,
     * therefore customer lead is
     * NOT lost.
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
     * BOTH FAILED
     */

    return reply(502, {
      success: false,
      message: RETRY,
    });
  } catch {
    console.error(
      "Unexpected callback failure"
    );

    return reply(502, {
      success: false,
      message: RETRY,
    });
  }
}
