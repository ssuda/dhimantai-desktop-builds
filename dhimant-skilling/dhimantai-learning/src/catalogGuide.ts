import type { Course } from './api';
import { ERP_COURSE } from './browserCourseProgress';
import { escape, typeIcon } from './catalogLayout';
import { accessPeriod, type CatalogCourse } from './learnerCatalog';

type Button = (label: string, action: string, id?: string, disabled?: boolean, secondary?: boolean) => string;

export function setupCourseNames(courses?: Course[]): string[] {
  return (courses ?? []).filter(course => course.name !== ERP_COURSE && course.chapters.some(ch => !ch.locked && !ch.expired))
    .map(course => course.name);
}

export function accessFacts(courses: CatalogCourse[]) {
  const personal = courses.filter(course => !course.company_training);
  let duration = 'See the period on your course.';
  if (personal.length && personal.every(course => course.access_days)) {
    const days = personal.map(course => course.access_days!);
    const min = Math.min(...days), max = Math.max(...days);
    duration = min === max ? `${min} days from joining or purchase.` : `${min}–${max} days, depending on the course.`;
  }
  return `<dl class="access-facts" aria-label="Individual course access at a glance">
    <div><dt>Course price</dt><dd>Look for “All chapters free” or “Chapter 1 free”.</dd></div>
    <div><dt>One-time payment</dt><dd>Unlock a paid course. No auto-renewal.</dd></div>
    <div><dt>Access duration</dt><dd>${escape(duration)}</dd></div></dl>`;
}

interface GuideOptions {
  button: Button;
  courses: CatalogCourse[];
  lessons?: Course[];
  signedIn: boolean;
  desktop: boolean;
  shortcut: string;
  loading: boolean;
  message: string;
  setup?: {message: string; busy: boolean};
}

export function catalogGuide({button, courses, lessons, signedIn, desktop, shortcut, loading, message, setup}: GuideOptions) {
  const names = setupCourseNames(lessons);
  const dated = courses.filter(course => course.enrolled && course.access_until);
  const topics = [
    {id:'learning', title:'Learning', icon:'campus', content:`
      <p>Open a chapter with <strong>Instructor</strong> for a guided lesson. Bring a specific question or code snippet to <strong>Doubt Solver</strong>.</p>
      <p>Lesson coverage records what Instructor has taught. Your grade and certificate depend on the course assessments.</p>
      <h4>Find a desktop action</h4><p>Open the Command Palette, type part of an action name such as “course catalog”, then press Enter. The button searches dhimantAI commands.</p>
      ${button('Find a Command (' + shortcut + ')', 'commands', '', false, true)}`},
    {id:'code', title:'Run Your Code', icon:'engineering', content:`
      <p>Run code and tests in your course container. In a notebook, add a Bash cell to run shell commands or a SQL cell to query PostgreSQL.</p>
      <h4>Prepare your course container</h4><p>Allow about 5–10 minutes for the first setup. Download speed and course size can extend this. Keep an internet connection and follow any Podman installation prompts. Later runs reuse the container.</p>
      ${names.length ? `<label for="guide-course">Course</label><select id="guide-course"${setup?.busy ? ' disabled' : ''}>${names.map(name => `<option>${escape(name)}</option>`).join('')}</select><p id="guide-ready" class="small" role="status"></p>` : ''}
      <p class="small muted">${!signedIn ? 'Sign in, then choose a course to set up.' : loading ? 'Loading your courses…' : !lessons ? 'Refresh purchases to reload your course list.' : !names.length ? 'Join a course with an accessible coding chapter to use setup. ERPNext sets up its own sandbox when you open the guided tour.' : 'Setup checks the course packages and runs a sample program.'}</p>
      ${button('Set Up Course Container', signedIn ? 'setupCourse' : 'signInForSetup', '', signedIn && (!names.length || !!setup?.busy))}
      <p id="guide-setup-status" role="status">${escape(setup?.message ?? '')}</p>
      <p class="small muted">Active chapter access includes Project Mentor. Project time estimates exclude setup.</p>`},
    {id:'access', title:'Access & Payments', icon:'bundles', content:`
      ${accessFacts(courses)}
      <p>For individual learners, free courses include every chapter. Join a paid course to open its free first chapter. A one-time purchase unlocks the rest through Razorpay checkout in your browser.</p>
      <h4>When access ends</h4><p>Your access period starts when you join. Buying the course starts a fresh period from the payment date. Your course card shows when access ends. At expiry, every chapter locks, including the first. To renew a paid course, buy it again.</p>
      ${dated.length ? `<details><summary>Your course expiry dates</summary><ul>${dated.map(c => `<li><strong>${escape(c.title)}</strong> · ${escape(accessPeriod(c))}</li>`).join('')}</ul></details>` : ''}
      <p>Use <strong>Manage Payments</strong> for orders and receipts. After checkout, choose <strong>Refresh Purchases</strong> to check the order and update course access.</p>`},
    {id:'ai', title:'AI Help Rules', icon:'ai', content:`
      <h4>Why Copilot is disabled</h4><p>Most lessons ask you to write and check your own code. ${desktop ? 'The desktop turns off Copilot chat and suggestions in the catalogue and in lessons that require independent work.' : 'The extension turns off built-in AI features by default in VS Code.'} Instructor and Doubt Solver remain available for learning.</p>
      <h4>How to restore Copilot</h4><p>${desktop ? 'Open an eligible lesson in <strong>Use AI Coding Help with Verification</strong>. The desktop enables Copilot for that lesson. Install a compatible Copilot Chat extension and sign in to GitHub to use it. For independent work outside the course, use your regular VS Code window.' : 'In VS Code Settings, search for <strong>Chat: Disable AI Features</strong> and turn it off. Check workspace settings if it stays disabled, then sign in to your Copilot extension.'}</p>`},
    {id:'system', title:'System Requirements', icon:'essentials', content:`
      <dl class="requirements"><div><dt>Container engine</dt><dd>Setup uses Podman to build and run the course Dockerfile in a trusted, local window. It can install Podman for you. On Windows, enable virtualization and use WSL 2 or Hyper-V.</dd></div>
      <div><dt>Memory</dt><dd>Standard coding courses allocate 2 GB to the Podman machine on macOS and Windows. ERPNext needs 6 GB for its runtime and at least 8 GB of system RAM for automatic setup on macOS.</dd></div>
      <div><dt>GPU</dt><dd>Ordinary coding lessons run on CPU. For GPU labs, use the course’s supported Colab, cloud or Jupyter runtime. You supply GPU access for Inference Engineering.</dd></div>
      <div><dt>Microphone</dt><dd>Allow microphone access for spoken questions. You can type questions and use the catalogue without a microphone.</dd></div></dl>`},
  ] as const;
  return `<dialog id="course-guide" aria-labelledby="guide-title">
    <header class="guide-heading">${typeIcon('other')}<h2 id="guide-title">Help &amp; Course Guide</h2>
      <form method="dialog"><button class="secondary" aria-label="Close course guide">Close</button></form></header>
    <div class="guide-body"><div class="guide-topics" role="tablist" aria-label="Guide topics">${topics.map((topic, i) =>
      `<button type="button" role="tab" id="tab-${topic.id}" aria-controls="guide-${topic.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${typeIcon(topic.icon)}${escape(topic.title)}</button>`).join('')}</div>
    ${topics.map((topic, i) => `<section role="tabpanel" id="guide-${topic.id}" aria-labelledby="tab-${topic.id}" tabindex="0"${i ? ' hidden' : ''}><h3>${escape(topic.title)}</h3>${topic.content}</section>`).join('')}</div>
    <footer><div class="actions">${button('Manage Payments','payments','',false,true)}${button(signedIn ? 'Refresh Purchases' : 'Refresh Courses','refresh','',loading,true)}
      ${button('Contact Support','support','',false,true)}</div><p id="guide-feedback" role="status">${escape(message)}</p></footer>
    </dialog>`;
}
