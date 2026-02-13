/**
 * ElevenLabs Agents - Google Calendar Integration
 *
 * Send calendar invites and confirmation emails via gog CLI.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { EmailTemplateType } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Map template type to file name */
const TEMPLATE_FILES: Record<EmailTemplateType, string> = {
  [EmailTemplateType.INTERVIEW_CONFIRMATION]: "interview-confirmation.html",
  [EmailTemplateType.FOLLOW_UP]: "follow-up.html",
  [EmailTemplateType.RESCHEDULE]: "reschedule.html",
};

/**
 * Parse email template type from data collection value.
 * Returns undefined if value doesn't match any known template type.
 */
export function parseEmailTemplateType(value: unknown): EmailTemplateType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const validValues = Object.values(EmailTemplateType) as string[];
  if (validValues.includes(normalized)) {
    return normalized as EmailTemplateType;
  }
  return undefined;
}

const execFileAsync = promisify(execFile);

const INTERVIEW_DURATION_MINUTES = 30;

export type SendInterviewInviteParams = {
  candidateName: string;
  candidateEmail: string;
  /** ISO 8601 timestamp for the interview start time */
  interviewTimestamp: string;
  /** Calendar ID (default: "primary") */
  calendarId: string;
  /** Conversation ID for reference */
  conversationId?: string;
  /** Email template type (default: INTERVIEW_CONFIRMATION) */
  templateType?: EmailTemplateType;
};

export type SendInterviewInviteResult = {
  ok: boolean;
  error?: string;
  calendarEventCreated?: boolean;
  emailSent?: boolean;
};

/**
 * Resolve the gog account from config or environment.
 */
export function resolveGogAccount(cfg: OpenClawConfig): string | undefined {
  // First check skills.entries.gog.env.GOG_ACCOUNT
  const skillsGogEnv = cfg.skills?.entries?.gog?.env;
  if (skillsGogEnv && typeof skillsGogEnv.GOG_ACCOUNT === "string") {
    const account = skillsGogEnv.GOG_ACCOUNT.trim();
    if (account) {
      return account;
    }
  }

  // Fallback to environment variable
  const envAccount = process.env.GOG_ACCOUNT?.trim();
  if (envAccount) {
    return envAccount;
  }

  return undefined;
}

/**
 * Format a date for display in email.
 */
function formatDateForEmail(date: Date): { date: string; time: string } {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return { date: dateStr, time: timeStr };
}

/**
 * Calculate end time by adding duration to start time.
 */
function calculateEndTime(startIso: string, durationMinutes: number): string {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return end.toISOString();
}

/**
 * Load and populate the email template with values.
 */
function buildEmailHtml(
  templateType: EmailTemplateType,
  params: {
    candidateName: string;
    interviewDate: string;
    interviewTime: string;
  },
): string {
  const templateFile =
    TEMPLATE_FILES[templateType] ?? TEMPLATE_FILES[EmailTemplateType.INTERVIEW_CONFIRMATION];
  const templatePath = join(__dirname, "templates", templateFile);
  let template: string;

  try {
    template = readFileSync(templatePath, "utf-8");
  } catch {
    // Fallback to inline template if file not found
    template = `<p>Hi {{candidate_name}},</p>
<p>Your interview has been scheduled for <strong>{{interview_date}}</strong> at <strong>{{interview_time}}</strong>.</p>
<p>You will receive a calendar invite shortly with the meeting details.</p>
<p>Best regards,<br>The Team</p>`;
  }

  return template
    .replace(/\{\{candidate_name\}\}/g, params.candidateName)
    .replace(/\{\{interview_date\}\}/g, params.interviewDate)
    .replace(/\{\{interview_time\}\}/g, params.interviewTime);
}

/**
 * Execute gog CLI command.
 */
async function runGogCommand(
  args: string[],
  gogAccount: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("gog", args, {
      env: { ...process.env, GOG_ACCOUNT: gogAccount },
      timeout: 30000, // 30 second timeout
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message,
    };
  }
}

/**
 * Send interview invite via Google Calendar and confirmation email via Gmail.
 */
export async function sendInterviewInvite(
  params: SendInterviewInviteParams,
  gogAccount: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<SendInterviewInviteResult> {
  const {
    candidateName,
    candidateEmail,
    interviewTimestamp,
    calendarId,
    conversationId,
    templateType = EmailTemplateType.INTERVIEW_CONFIRMATION,
  } = params;

  // Parse and validate timestamp
  const startDate = new Date(interviewTimestamp);
  if (isNaN(startDate.getTime())) {
    return { ok: false, error: `Invalid interview timestamp: ${interviewTimestamp}` };
  }

  const endIso = calculateEndTime(interviewTimestamp, INTERVIEW_DURATION_MINUTES);
  const { date: interviewDate, time: interviewTime } = formatDateForEmail(startDate);

  let calendarEventCreated = false;
  let emailSent = false;

  // 1. Create calendar event with attendee
  const eventSummary = `Interview with ${candidateName}`;
  const eventDescription = conversationId
    ? `Scheduled from ElevenLabs conversation: ${conversationId}`
    : "Scheduled interview";

  const calendarArgs = [
    "calendar",
    "create",
    calendarId,
    "--summary",
    eventSummary,
    "--from",
    interviewTimestamp,
    "--to",
    endIso,
    "--description",
    eventDescription,
    "--add-attendee",
    candidateEmail,
    "--no-input",
  ];

  log.info(`Creating calendar event for ${candidateName} at ${interviewTimestamp}`);
  const calendarResult = await runGogCommand(calendarArgs, gogAccount);

  if (calendarResult.ok) {
    calendarEventCreated = true;
    log.info(`Calendar event created for ${candidateName}`);
  } else {
    log.warn(`Failed to create calendar event: ${calendarResult.error}`);
    // Continue to try sending email even if calendar fails
  }

  // 2. Send confirmation email
  const emailHtml = buildEmailHtml(templateType, {
    candidateName,
    interviewDate,
    interviewTime,
  });

  const emailArgs = [
    "gmail",
    "send",
    "--to",
    candidateEmail,
    "--subject",
    `Interview Scheduled - ${interviewDate}`,
    "--body-html",
    emailHtml,
    "--no-input",
  ];

  log.info(`Sending confirmation email to ${candidateEmail}`);
  const emailResult = await runGogCommand(emailArgs, gogAccount);

  if (emailResult.ok) {
    emailSent = true;
    log.info(`Confirmation email sent to ${candidateEmail}`);
  } else {
    log.warn(`Failed to send confirmation email: ${emailResult.error}`);
  }

  // Return result
  if (!calendarEventCreated && !emailSent) {
    return {
      ok: false,
      error: `Both calendar and email failed. Calendar: ${calendarResult.error}. Email: ${emailResult.error}`,
      calendarEventCreated,
      emailSent,
    };
  }

  return {
    ok: true,
    calendarEventCreated,
    emailSent,
  };
}
