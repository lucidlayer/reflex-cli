#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";
const { version } = require("../package.json");

import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import ora from "ora";
import chalk from "chalk";
import { chromium, Browser, Page } from "playwright";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env.production" });

// Auto-install Playwright browsers silently if missing
import { execSync } from "child_process";

// Skip browser install for --version, --help, or no URL argument
const skipInstall =
  process.argv.includes("--version") ||
  process.argv.includes("-V") ||
  process.argv.includes("--help") ||
  process.argv.includes("-h") ||
  process.argv.length <= 2; // no URL argument provided

if (!skipInstall) {
  try {
    console.log("Checking Playwright browsers...");
    execSync("npx playwright install", { stdio: "inherit" });
  } catch (e) {
    console.warn("Warning: Playwright browsers could not be auto-installed. Please run 'npx playwright install' manually.");
  }
}

const program = new Command();

program
  .version(version)
  .name("uxcheck")
  .description("Run AI-powered UX feedback on your web app")
  .argument("<url>", "URL of the app to scan")
  .option("--goal <goal>", "User goal to simulate", "Look through the about page and see if its easy to understand what the website or application does")
  .option("--persona <persona>", "Persona description", "a new user with no prior knowledge")
  .option("--json", "Output JSON report in addition to markdown")
  .option("--manual", "Output prompt for manual copy-paste instead of calling API")
  .option("--apiKey <apiKey>", "OpenRouter API key")
  .option("--model <model>", "Model to use", "openrouter/quasar-alpha")
  .parse(process.argv);

const options = program.opts();
const targetUrl = program.args[0];

const apiKey = options.apiKey || process.env.REFLEX_OPENROUTER_API_KEY;
const model = options.model;

if (!apiKey) {
  console.error("\n[Reflex CLI] ERROR: No OpenRouter API key found.");
  console.error("Please set it via --apiKey flag or in a .env file as REFLEX_OPENROUTER_API_KEY.");
  console.error("Get your key at https://openrouter.ai\n");
  process.exit(1);
}

console.log(`[Reflex CLI] Using model: ${model}`);

async function run() {
  const reflexRoot = path.join(process.cwd(), ".reflex");
  const reportsDir = path.join(reflexRoot, "reports");
  const logsDir = path.join(reflexRoot, "logs");

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const timestamp = Date.now();
  const logFile = path.join(logsDir, `log-${timestamp}.txt`);

  const spinner = ora("Launching browser...").start();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 }, // iPhone SE size
      colorScheme: "dark", // emulate dark mode
    });
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    // Wait extra time to allow animations, gradients, fonts, etc. to fully load
    await page.waitForTimeout(2000);
    spinner.text = "Capturing screenshot and DOM...";

    const timestamp = Date.now();

    function slugify(text: string) {
      return text.toLowerCase()
        .replace(/https?:\/\//, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 30);
    }

    const urlSlug = slugify(targetUrl);
    const goalSlug = slugify(options.goal || "");
    const personaSlug = slugify(options.persona || "");

    const baseName = `reflex-${timestamp}-${urlSlug}-${goalSlug}-${personaSlug}`;

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    const screenshotPath = path.join(reportsDir, `${baseName}.png`);
    fs.writeFileSync(screenshotPath, screenshotBuffer);

    const domSummary = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll("h1,h2,h3,p,button,a,input,label"));
      return elements.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          text: (el as HTMLElement).innerText.trim(),
          id: el.id || null,
          class: el.className || null,
          fontSize: style.fontSize,
          color: style.color,
          backgroundColor: style.backgroundColor,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
        };
      });
    });

    spinner.text = "Building prompt...";

    const prompt = `
You are a senior UX designer reviewing a mobile screen for a web application.

Persona: ${options.persona}
Goal: ${options.goal}

Focus on:
- Visual hierarchy
- Text clarity
- Layout problems
- Accessibility

Be detailed in your feedback.

Here is the DOM summary:
${JSON.stringify(domSummary, null, 2)}
`;

    if (options.manual) {
      const promptPath = path.join(reportsDir, `${baseName}-prompt.txt`);
      fs.writeFileSync(promptPath, prompt);
      spinner.succeed(`Prompt saved for manual use: ${promptPath}`);
      return;
    }

    spinner.text = "Sending prompt to OpenRouter...";

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        messages: [
          { role: "system", content: "You are a helpful UX expert." },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const feedback = response.data.choices[0].message.content as string;

    const mdPath = path.join(reportsDir, `${baseName}.md`);
    fs.writeFileSync(mdPath, feedback);

    if (options.json) {
      const jsonPath = path.join(reportsDir, `${baseName}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify({ feedback }, null, 2));
    }

    spinner.succeed(`UX feedback saved to ${mdPath}`);
  } catch (error: any) {
    spinner.fail("Error during UX check");
    console.error(error.message || error);

    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Error:\n${error.stack || error.message || error}\n`);
      console.error(`[Reflex CLI] Error details saved to ${logFile}`);
    } catch (logErr) {
      console.error("[Reflex CLI] Failed to write error log.");
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

run();
