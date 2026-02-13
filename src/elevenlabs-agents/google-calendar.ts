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
  /** ISO 8601 timestamp for the interview start time (optional - skip calendar if not provided) */
  interviewTimestamp?: string;
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
 * Get shell config for running commands (like the agent does).
 */
function getShellConfig(): { shell: string; args: string[] } {
  const envShell = process.env.SHELL?.trim();
  const shell = envShell && envShell.length > 0 ? envShell : "/bin/sh";
  return { shell, args: ["-l", "-c"] }; // -l for login shell to get full env
}

/**
 * Escape a string for shell usage.
 */
function shellEscape(str: string): string {
  // Use single quotes and escape any single quotes within
  return `'${str.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Execute gog CLI command through a login shell (like the agent does).
 * This ensures access to keychain credentials and full PATH.
 */
async function runGogCommand(
  args: string[],
  gogAccount: string,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }> {
  const { shell, args: shellArgs } = getShellConfig();

  // Build the full command string
  const gogCmd = ["gog", ...args.map(shellEscape)].join(" ");
  const cmdStr = gogCmd;
  log.info(`[gog] Running: ${cmdStr}`);
  log.info(`[gog] Account: ${gogAccount}`);
  log.info(`[gog] Shell: ${shell} ${shellArgs.join(" ")}`);

  try {
    const { stdout, stderr } = await execFileAsync(shell, [...shellArgs, gogCmd], {
      env: { ...process.env, GOG_ACCOUNT: gogAccount },
      timeout: 30000, // 30 second timeout
    });
    if (stdout) {
      log.info(`[gog] stdout: ${stdout.trim()}`);
    }
    if (stderr) {
      log.warn(`[gog] stderr: ${stderr.trim()}`);
    }
    return { ok: true, stdout, stderr };
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string; code?: string };
    log.warn(`[gog] Command failed: ${error.message}`);
    if (error.stdout) {
      log.warn(`[gog] stdout: ${error.stdout.trim()}`);
    }
    if (error.stderr) {
      log.warn(`[gog] stderr: ${error.stderr.trim()}`);
    }
    if (error.code) {
      log.warn(`[gog] Exit code: ${error.code}`);
    }
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message,
    };
  }
}

/**
 * Send interview invite via Google Calendar and/or confirmation email via Gmail.
 * Calendar invite is only created if interviewTimestamp is provided.
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

  let calendarEventCreated = false;
  let emailSent = false;
  let interviewDate = "";
  let interviewTime = "";

  // 1. Create calendar event (only if timestamp provided)
  if (interviewTimestamp) {
    const startDate = new Date(interviewTimestamp);
    if (isNaN(startDate.getTime())) {
      log.warn(`Invalid interview timestamp: ${interviewTimestamp}, skipping calendar`);
    } else {
      const endIso = calculateEndTime(interviewTimestamp, INTERVIEW_DURATION_MINUTES);
      const formatted = formatDateForEmail(startDate);
      interviewDate = formatted.date;
      interviewTime = formatted.time;

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
        "--attendees",
        candidateEmail,
        "--no-input",
      ];

      log.info(`Creating calendar event for ${candidateName} at ${interviewTimestamp}`);
      const calendarResult = await runGogCommand(calendarArgs, gogAccount, log);

      if (calendarResult.ok) {
        calendarEventCreated = true;
        log.info(`Calendar event created for ${candidateName}`);
      } else {
        log.warn(`Failed to create calendar event: ${calendarResult.error}`);
      }
    }
  } else {
    log.info(`No interview timestamp provided, skipping calendar invite`);
  }

  // 2. Send email
  const emailHtml = buildEmailHtml(templateType, {
    candidateName,
    interviewDate,
    interviewTime,
  });

  // Use different subject based on whether we have a scheduled date
  const emailSubject = interviewDate
    ? `Interview Scheduled - ${interviewDate}`
    : `Follow-up from Deriv`;

  const emailArgs = [
    "gmail",
    "send",
    "--to",
    candidateEmail,
    "--subject",
    emailSubject,
    "--body-html",
    emailHtml,
    "--no-input",
  ];

  log.info(`Sending confirmation email to ${candidateEmail}`);
  const emailResult = await runGogCommand(emailArgs, gogAccount, log);

  if (emailResult.ok) {
    emailSent = true;
    log.info(`Confirmation email sent to ${candidateEmail}`);
  } else {
    log.warn(`Failed to send confirmation email: ${emailResult.error}`);
  }

  // Return result
  if (!emailSent) {
    return {
      ok: false,
      error: `Email failed: ${emailResult.error}`,
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
