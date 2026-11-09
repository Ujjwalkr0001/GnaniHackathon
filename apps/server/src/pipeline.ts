import { z } from 'zod';
import { isWithinCallingWindow, type Campaign, type CallResult, type Outcome, type Turn } from '../../../packages/shared/src/index.js';
import type {
  DialogueClient,
  SttClient,
  SttEvent,
  ToolCall,
  Transport,
  TtsClient,
} from './contracts.js';
import {
  CallFlow,
  agentVersion,
  eligibility,
  opening,
  questions,
  safeReply,
  shouldSubmit,
  validateFields,
} from './domain.js';
import { FrameBuffer } from './audio.js';
import { redactSensitive } from './security.js';
import { analyzeCall } from './analysis.js';
import { parseCallbackPhrase } from '../../../src/utils/time-parser.js';
import { isCandidateQuestion, mustHaveAnswer, recruitmentQaCompletion, recruitmentQuestions, requirementRejection, screeningAnswer, screeningAnswerNeedsClarification, verbalConsent } from './recruitment.js';
import { PreparedSpeech } from './providers/prepared-speech.js';
export interface PipelineHooks {
  event(type: string, data: unknown): void;
  suppress(): Promise<void>;
  complete(result: CallResult): Promise<void>;
  usage?(stt: number, tts: number): Promise<boolean>;
}
export class ConversationPipeline {
  readonly flow = new CallFlow();
  readonly transcript: Turn[] = [];
  readonly fields: Record<string, string | boolean | number> = {};
  readonly tools: CallResult['tool_log'] = [];
  readonly trace: CallResult['provider_trace'] = [];
  readonly latency: CallResult['latency'] = [];
  private started = Date.now();
  private abort = new AbortController();
  private generation = 0;
  private finishing?: Promise<void>;
  private duration?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private idleCount = 0;
  private outcome?: Outcome;
  private interest?: 'hot' | 'warm' | 'cold';
  private language: string;
  private spokenLanguages = new Set<string>();
  private sttSeconds = 0;
  private ttsChars = 0;
  private tokens = 0;
  private busy = false;
  private toolResult: unknown;
  private repeatCount = 0;
  private hrIndex = 0;
  private hrClarified = new Set<string>();
  private hrQaUnclear = 0;
  private hrQaUnavailable = 0;
  private hrCloseClarifications = 0;
  private lastQuestion = '';
  private speech: PreparedSpeech;
  private responseContext?: {
    generation: number;
    finalAt: number;
    endAt?: number;
    timing: CallResult['latency'][number];
  };
  private resolveIntro!: () => void;
  private introDone = new Promise<void>((resolve) => {
    this.resolveIntro = resolve;
  });
  callbackAt?: string;
  constructor(
    readonly campaign: Campaign,
    readonly campaignId: string,
    readonly contactId: string | undefined,
    readonly stt: SttClient,
    readonly tts: TtsClient,
    readonly dialogue: DialogueClient,
    readonly transport: Transport,
    readonly hooks: PipelineHooks,
    readonly simulation: boolean,
    private firstName = '',
  ) {
    this.language = campaign.languages[0];
    if (campaign.type === 'hr') {
      const plan = recruitmentQuestions(campaign);
      this.campaign = { ...campaign, screening_questions: plan.length ? plan : [{
        question: 'What job-related experience would you like to share?',
        field_key: 'relevant_experience', required: true, must_have: false, expected_answer_hint: '',
      }] };
    }
    this.speech = new PreparedSpeech(tts, async (chars) => {
      this.ttsChars += chars;
      if (this.hooks.usage && !(await this.hooks.usage(this.sttSeconds, this.ttsChars))) {
        this.ttsChars -= chars;
        throw new Error('Usage cap reached');
      }
    });
  }
  provider(provider: string, event: string) {
    const trace = { provider, event, at: new Date().toISOString() };
    this.trace.push(trace);
    this.hooks.event('provider', trace);
  }
  async start() {
    this.stt.onActivity = () => this.bargeIn();
    this.stt.onTurn = (e) => {
      void this.turn(e).catch((error: unknown) => {
        // A caller can interrupt TTS. Its aborted request belongs to the old
        // turn and must not terminate the newly started conversation turn.
        if (error instanceof Error && error.name === 'AbortError') return;
        this.hooks.event('error', {
          code: 'TURN_FAILED',
          name: error instanceof Error ? error.name : 'Unknown',
        });
        if (!this.abort.signal.aborted) return this.finish('FAILED');
      });
    };
    this.stt.onError = (error) => {
      this.hooks.event('error', { message: error.message });
      void this.finish('FAILED');
    };
    await this.stt.connect();
    this.provider(
      this.simulation ? 'Mock STT (simulation)' : 'Speech recognition',
      'ready; see connection/failover trace for actual provider',
    );
    this.provider(this.dialogue.name, 'selected');
    this.duration = setTimeout(() => {
      this.hooks.event('exit', 'TIMEOUT');
      void this.finish(this.outcome ?? 'INCOMPLETE', 'duration_limit');
    }, this.campaign.max_call_duration_s * 1000);
    await this.say(opening(this.campaign, this.firstName), undefined, undefined, () => {
      if (this.campaign.type === 'hr' && !this.simulation) this.prepareHrQuestion(0);
    });
    this.flow.advance('PERMISSION');
    this.resolveIntro();
    this.hooks.event('stage', this.flow.stage);
    this.armIdle();
  }
  input(pcm: Buffer) {
    if (!this.finishing) {
      this.sttSeconds += pcm.length / 16000;
      if (this.sttSeconds > this.campaign.max_call_duration_s) {
        void this.finish('FAILED');
        return;
      }
      this.stt.sendAudio(pcm);
    }
  }
  bargeIn() {
    if (!this.busy || this.flow.stage === 'GREETING_DISCLOSURE') return;
    this.generation++;
    this.abort.abort();
    this.transport.clear();
    this.busy = false;
    this.hooks.event('barge_in', { at: Date.now() });
  }
  private armIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(
      () => {
        if (++this.idleCount > 1) void this.finish(this.outcome ?? 'INCOMPLETE', 'idle_timeout');
        else
          void this.say('Are you still there?')
            .then(() => this.armIdle())
            .catch(() => this.finish('FAILED'));
      },
      Number(process.env.IDLE_TIMEOUT_SECONDS ?? 25) * 1000,
    );
  }
  private record(role: Turn['role'], text: string) {
    const turn = {
      role,
      text: redactSensitive(text, this.campaign.type === 'hr'),
      at: new Date().toISOString(),
    };
    this.transcript.push(turn);
    this.hooks.event('transcript', turn);
  }
  private advance(stage: Parameters<CallFlow['advance']>[0]) {
    this.flow.advance(stage);
    this.hooks.event('stage', stage);
  }
  private hrPrompt(index: number) {
    const plan = this.campaign.screening_questions, q = plan[index];
    if (!q) return '';
    if (index === 0 && q.must_have)
      return `Thank you. I'll first check the essential requirements. ${q.question}`;
    if (index === plan.findIndex((question) => !question.must_have))
      return `Thank you.${index ? " You've confirmed the essential requirements." : ''} ${this.hrRoleInformation()} I have a few more questions. ${q.question}`;
    return q.question;
  }
  private hrRoleInformation() {
    const c = this.campaign;
    const summary = c.role_summary.trim() || `The position is ${c.job_title} at ${c.company_name}.`;
    return [/[.!?]$/.test(summary) ? summary : `${summary}.`,
      c.work_mode ? `The work arrangement is ${c.work_mode}.` : '',
      c.location ? `The location is ${c.location}.` : '',
      c.salary_range_text ? `The approved salary range is ${c.salary_range_text}.` : '',
    ].filter(Boolean).join(' ');
  }
  private async continueRecruitment(index: number) {
    const q = this.campaign.screening_questions[index];
    if (q) {
      if (!q.must_have && this.flow.stage === 'DISCOVERY_SCREENING') this.advance('PITCH_ROLE_INTRO');
      await this.askHrQuestion(index);
      return;
    }
    const introduceRole = this.flow.stage === 'DISCOVERY_SCREENING';
    if (introduceRole) this.advance('PITCH_ROLE_INTRO');
    this.advance('OBJECTIONS_QA');
    this.lastQuestion = 'What questions do you have about the role?';
    await this.say(`${introduceRole ? `Thank you. You've confirmed the essential requirements. ${this.hrRoleInformation()} ` : ''}${this.lastQuestion}`);
    this.armIdle();
  }
  private prepareHrQuestion(index: number) {
    const text = this.hrPrompt(index);
    if (text) this.speech.prepare(text, this.language,
      this.campaign.voice[this.language as Campaign['languages'][number]] ?? 'Shivani');
  }
  private async askHrQuestion(index: number) {
    this.hrIndex = index;
    this.lastQuestion = this.campaign.screening_questions[index].question;
    this.hooks.event('screening_question', {
      field_key: this.campaign.screening_questions[index].field_key,
      ordinal: index + 1, total: this.campaign.screening_questions.length,
    });
    await this.say(this.hrPrompt(index), undefined, undefined, () => {
      if (!this.simulation) this.prepareHrQuestion(index + 1);
    });
    this.armIdle();
  }
  private async closeRecruitmentQa(reason: string, prefix = '') {
    this.hooks.event('qa_progress', {action: 'closing', reason});
    this.advance('CLOSE');
    this.lastQuestion = 'May the team follow up with you about the next steps?';
    await this.say(`${prefix ? `${prefix} ` : ''}${this.lastQuestion}`);
    this.armIdle();
  }
  private async unclearRecruitmentQa() {
    this.hooks.event('qa_progress', {action: 'unclear', count: ++this.hrQaUnclear});
    if (this.hrQaUnclear >= 2) {
      await this.closeRecruitmentQa('unclear_limit', "Let's finish the screening here.");
    } else {
      this.lastQuestion = '';
      await this.say("I couldn't make out a question. Please ask it now, or say no questions if you're finished.");
      this.armIdle();
    }
  }
  private async structuredRecruitment(text: string) {
    if (this.responseContext) this.responseContext.timing.route = 'structured';
    if ((this.flow.stage === 'OBJECTIONS_QA' || this.flow.stage === 'CLOSE')
      && recruitmentQaCompletion(text) === 'finish') {
      await this.say('Thank you for your time. Goodbye.');
      await this.finish('CANDIDATE_COMPLETED', 'candidate_requested_end');
      return true;
    }
    if (this.flow.stage === 'PERMISSION') {
      if (isCandidateQuestion(text)) return false;
      if (verbalConsent(text) === true) {
        this.advance('DISCOVERY_SCREENING');
        await this.continueRecruitment(0);
      } else {
        await this.say('Is this a good time for a brief job-related screening?');
        this.armIdle();
      }
      return true;
    }
    if (this.flow.stage === 'DISCOVERY_SCREENING' || this.flow.stage === 'PITCH_ROLE_INTRO') {
      if (isCandidateQuestion(text)) return false;
      const q = this.campaign.screening_questions[this.hrIndex];
      let answer = q.must_have ? mustHaveAnswer(q, text) : screeningAnswer(text.slice(0, 500), q.expected_answer_hint);
      const vague = answer === undefined || (!q.must_have && !/^(yes|no)$/i.test(q.expected_answer_hint.trim())
        && (/^(hello|hi|hey|yes|yeah|no|okay|ok|sure)[.!\s]*$/i.test(text)
          || screeningAnswerNeedsClarification(q.field_key, text)));
      if (vague) {
        if (!this.hrClarified.has(q.field_key)) {
          this.hrClarified.add(q.field_key);
          await this.say(`${q.must_have ? 'Please confirm with yes or no, or tell me how much relevant experience you have.' : 'Could you give a brief answer in your own words?'} ${q.question}`);
          this.armIdle();
          return true;
        }
        answer = 'unknown';
      }
      const result = await this.tool({ name: 'capture_fields', args: {
        fields: { [q.field_key]: answer },
      } }, text);
      if (result && typeof result === 'object' && 'error' in result) {
        await this.say(`Please keep your answer focused on the role. ${q.question}`);
        this.armIdle();
        return true;
      }
      if (q.must_have) {
        this.hooks.event('must_have_assessment', { field_key: q.field_key,
          status: answer === 'unknown' ? 'unconfirmed' : answer?.toLowerCase() === q.expected_answer_hint.trim().toLowerCase() ? 'met' : 'not_met' });
        if (answer === 'unknown') {
          await this.say("We couldn't confirm this essential requirement, so I'll leave the screening here for the team to review. Thank you for your time. Goodbye.");
          await this.finish('INCOMPLETE', 'must_have_unconfirmed');
          return true;
        }
        if (answer?.toLowerCase() !== q.expected_answer_hint.trim().toLowerCase()) {
          await this.say(requirementRejection(q));
          await this.finish('CANDIDATE_REQUIREMENTS_NOT_MET', 'must_have_not_met');
          return true;
        }
      }
      await this.continueRecruitment(this.hrIndex + 1);
      return true;
    }
    if (this.flow.stage === 'OBJECTIONS_QA') {
      if (recruitmentQaCompletion(text) === 'close') {
        await this.closeRecruitmentQa('caller_done');
        return true;
      }
      if (/^(?:tell me more|continue|go ahead)[.!\s]*$/i.test(text)) {
        this.lastQuestion = '';
        await this.say(this.hrRoleInformation());
        this.armIdle();
        return true;
      }
      return false;
    }
    if (this.flow.stage === 'CLOSE') {
      const consent = verbalConsent(text);
      if (consent === undefined) {
        if (++this.hrCloseClarifications >= 2) {
          await this.say('Thank you for your time. Goodbye.');
          await this.finish('CANDIDATE_COMPLETED', 'follow_up_unconfirmed');
        } else {
          await this.say('Please say yes or no: may the team contact you about the next steps?');
          this.armIdle();
        }
      } else {
        await this.tool({ name: 'capture_fields', args: { fields: { consent_to_follow_up: consent } } }, text);
        this.advance('WRAP_UP');
        await this.say('Thank you for your time. Goodbye.');
        await this.finish('CANDIDATE_COMPLETED', 'screening_completed');
      }
      return true;
    }
    return false;
  }
  async turn(e: SttEvent) {
    if (this.flow.stage === 'GREETING_DISCLOSURE') await this.introDone;
    if (this.finishing) return;
    clearTimeout(this.idle);
    this.idleCount = 0;
    this.bargeIn();
    const token = ++this.generation;
    this.abort = new AbortController();
    this.responseContext = {
      generation: token, finalAt: e.finalAt, endAt: e.endOfSpeechAt,
      timing: { route: 'control', stt_final_ms: e.endOfSpeechAt ? e.finalAt - e.endOfSpeechAt : undefined },
    };
    this.busy = true;
    const text = redactSensitive(e.text.trim(), this.campaign.type === 'hr');
    this.record('caller', text);
    const lang = e.language?.includes('-')
      ? e.language
      : e.language
        ? `${e.language}-IN`
        : undefined;
    if (
      text.length >= 12 &&
      lang &&
      this.campaign.languages.includes(lang as Campaign['languages'][number])
    )
      this.language = lang;
    this.spokenLanguages.add(this.language);
    if (
      /do not call|don't call|stop calling|remove my number|never call|do not contact|don't contact|^stop[.!]?\s*$|मुझे कॉल मत|कॉल मत करना|फोन मत|కాల్ చేయవద్దు|కాల్ చేయకండి|ఫోన్ చేయొద్దు|அழைக்க வேண்டாம்/i.test(
        text,
      )
    ) {
      await this.tool({ name: 'mark_do_not_call', args: {} }, text);
      await this.say('I am sorry. I have added your number to our do-not-call list. Goodbye.');
      return this.finish('DO_NOT_CALL');
    }
    if (/wrong (person|number)|not the right person/i.test(text)) {
      await this.say('Sorry for the interruption. Goodbye.');
      return this.finish('WRONG_NUMBER');
    }
    if (/\b(fuck|go away|leave me alone|shut up)\b/i.test(text)) {
      await this.say('I am sorry for the interruption. Goodbye.');
      return this.finish('NOT_INTERESTED');
    }
    if (/please repeat|(?:can|could) you repeat|repeat (?:that|it|the question)|^repeat[.!]?\s*$|say (?:that|it|the question) again|come again|didn.t (?:hear|catch)/i.test(text)) {
      const previous = this.transcript.filter((turn) => turn.role === 'agent').at(-1);
      await this.say(this.lastQuestion || previous?.text || 'Is this a good time?');
      this.armIdle();
      return;
    }
    if (
      !/\p{L}/u.test(text) ||
      /unintelligible|noisy line|^what\??$|cannot hear|can't hear/i.test(text)
    ) {
      if (++this.repeatCount >= 2) {
        await this.say('We can try another time. Thank you. Goodbye.');
        return this.finish('NOT_INTERESTED');
      }
      await this.say('Could you please repeat that?');
      this.armIdle();
      return;
    }
    this.repeatCount = 0;
    if (/not interested|no interest|नहीं चाहिए/i.test(text)) {
      await this.say('Thank you for your time. Goodbye.');
      return this.finish(this.campaign.type === 'hr' ? 'CANDIDATE_DECLINED' : 'NOT_INTERESTED');
    }
    if (/call me (later|tomorrow|after)|call (?:me )?back|schedule.*callback|callback.*(?:tomorrow| at | on )|कल.*कॉल/i.test(text)) {
      const result = await this.tool(
        { name: 'schedule_callback', args: { when_text: text } },
        text,
      );
      await this.say(
        this.callbackAt
          ? 'Thank you. The team will call at the confirmed time. Goodbye.'
          : 'Please confirm an exact day and time for the callback.',
      );
      if (this.callbackAt) return this.finish('CALLBACK');
      this.toolResult = result;
      this.armIdle();
      return;
    }
    if (/are you (a )?(robot|human|ai)|real person/i.test(text)) {
      await this.say(
        'I am an AI assistant calling on behalf of ' + this.campaign.company_name + '.',
      );
      this.armIdle();
      return;
    }
    if (/(?:speak|talk|connect|transfer).*(?:human|person|team)|(?:human|person) please/i.test(text)) {
      await this.tool({ name: 'request_handoff', args: {} }, text);
      await this.say(
        'I can arrange a callback from the team. What exact day and time works for you?',
      );
      this.armIdle();
      return;
    }
    if (this.flow.stage === 'PERMISSION' && /\bno\b|busy|bad time/i.test(text)) {
      await this.say('Understood. Goodbye.');
      return this.finish('NOT_INTERESTED');
    }
    if (this.campaign.type === 'hr' && await this.structuredRecruitment(text)) return;
    if (
      this.flow.stage === 'PERMISSION' &&
      /\b(yes|sure|okay|ok|please|go ahead|good time)\b|हाँ|हां/i.test(text)
    ) {
      this.flow.advance('DISCOVERY_SCREENING');
      this.hooks.event('stage', this.flow.stage);
      const firstQuestion = questions(this.campaign)[0];
      await this.say(firstQuestion?.question ?? (this.campaign.type === 'hr'
        ? 'What job-related experience would you like to share?'
        : 'What are you looking for?'));
      this.armIdle();
      return;
    }
    const timing = this.responseContext.timing;
    timing.route = 'dialogue';
    const began = Date.now();
    const reply = await this.dialogue.reply(
      this.campaign,
      this.transcript,
      this.flow.stage,
      { ...this.fields, last_tool_results: this.toolResult },
      this.abort.signal,
      () => {
        timing.llm_first_token_ms = Date.now() - began;
      },
    );
    if (token !== this.generation || this.finishing) return;
    this.tokens += reply.tokens;
    if (this.campaign.type === 'hr' && this.flow.stage === 'OBJECTIONS_QA') {
      const status = reply.qa_status ?? (isCandidateQuestion(text) ? 'question' : 'unclear');
      this.hooks.event('qa_progress', {action: 'classified', status});
      if (status === 'done') {
        await this.closeRecruitmentQa('dialogue_done');
        return;
      }
      if (status === 'end_call') {
        await this.say('Thank you for your time. Goodbye.');
        await this.finish('CANDIDATE_COMPLETED', 'candidate_requested_end');
        return;
      }
      if (status === 'unclear') {
        await this.unclearRecruitmentQa();
        return;
      }
      this.hrQaUnclear = 0;
    }
    const results: unknown[] = [];
    for (const tool of reply.tools) {
      if (this.campaign.type === 'hr' && ['capture_fields', 'advance_stage', 'end_call', 'set_interest_level'].includes(tool.name)) continue;
      results.push(await this.tool(tool, text));
    }
    this.toolResult = results;
    let spoken = reply.text;
    if (this.campaign.type === 'hr') {
      spoken = (spoken.match(/[^.!?]+[.!?]?/g) ?? [])
        .filter((sentence) => !sentence.includes('?')).join(' ').trim()
        || 'The team will follow up with that information.';
      spoken = safeReply(this.campaign, spoken);
      if (/may (?:the )?team follow up/i.test(spoken)) spoken = 'The team will follow up with that information.';
      if (this.flow.stage === 'OBJECTIONS_QA' && /the team will follow up/i.test(spoken)) {
        if (++this.hrQaUnavailable >= 2) {
          await this.closeRecruitmentQa('unavailable_answer_limit', "I don't have further approved details to add.");
          return;
        }
      }
      if (this.flow.stage === 'DISCOVERY_SCREENING' || this.flow.stage === 'PITCH_ROLE_INTRO') spoken += ` ${this.lastQuestion}`;
      else if (this.flow.stage === 'PERMISSION') spoken += ' Is this a good time for a brief screening?';
      else if (this.flow.stage === 'OBJECTIONS_QA') this.lastQuestion = '';
    } else if (/may (?:the )?team follow up with you/i.test(spoken) && this.flow.stage !== 'CLOSE') {
      const pending = questions(this.campaign).find((q) => this.fields[q.field_key] === undefined);
      if (this.flow.stage === 'PERMISSION') spoken = 'Is this a good time?';
      else if (this.flow.stage === 'DISCOVERY_SCREENING' && pending) spoken = pending.question;
      else if (this.flow.stage === 'DISCOVERY_SCREENING') {
        this.flow.advance('PITCH_ROLE_INTRO');
        this.hooks.event('stage', this.flow.stage);
        spoken = this.campaign.product_description || this.campaign.fact_sheet || 'What questions do you have?';
      } else spoken = 'What questions do you have?';
    }
    await this.say(
      this.outcome === 'DO_NOT_CALL'
        ? 'I am sorry. Your number has been added to our do-not-call list. Goodbye.'
        : this.campaign.type === 'hr' ? spoken : safeReply(this.campaign, spoken),
      timing,
      e.endOfSpeechAt,
    );
    this.busy = false;
    if (
      this.outcome === 'DO_NOT_CALL' ||
      this.outcome === 'WRONG_NUMBER' ||
      this.flow.stage === 'WRAP_UP'
    )
      return this.finish(this.outcome);
    this.armIdle();
  }
  async tool(call: ToolCall, callerText: string): Promise<unknown> {
    let result: unknown;
    try {
      switch (call.name) {
        case 'capture_fields':
          Object.assign(
            this.fields,
            validateFields(
              this.campaign,
              z.record(z.string(), z.unknown()).parse(call.args.fields),
              callerText,
            ),
          );
          result = { captured: Object.keys(this.fields) };
          break;
        case 'advance_stage': {
          const complete = questions(this.campaign)
            .filter((q) => q.required || q.must_have)
            .every((q) => this.fields[q.field_key] !== undefined);
          this.flow.advance(
            z
              .enum([
                'PERMISSION',
                'DISCOVERY_SCREENING',
                'PITCH_ROLE_INTRO',
                'OBJECTIONS_QA',
                'CLOSE',
                'WRAP_UP',
              ])
              .parse(call.args.stage),
            complete,
          );
          this.hooks.event('stage', this.flow.stage);
          result = { stage: this.flow.stage };
          break;
        }
        case 'set_interest_level':
          this.interest = z.enum(['hot', 'warm', 'cold']).parse(call.args.level);
          result = { interest: this.interest };
          break;
        case 'mark_do_not_call':
          await this.hooks.suppress();
          this.outcome = 'DO_NOT_CALL';
          result = { suppressed: true };
          break;
        case 'mark_wrong_number':
          this.outcome = 'WRONG_NUMBER';
          result = { wrong_number: true };
          break;
        case 'schedule_callback': {
          const phrase = z.string().max(500).parse(call.args.when_text),
            parsed = parseCallbackPhrase(phrase, new Date());
          if (!parsed?.isExplicitTime)
            throw new Error('Ask caller for an explicit confirmed day and time');
          const clock = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).format(parsed.date);
          if (!isWithinCallingWindow(clock, this.campaign.schedule.start, this.campaign.schedule.end))
            throw new Error('Ask for a time inside the calling window');
          this.callbackAt = parsed.date.toISOString();
          this.outcome = 'CALLBACK';
          result = { callback_at: this.callbackAt };
          break;
        }
        case 'request_handoff':
          result = {
            mode: 'callback',
            instruction: 'Ask for a specific callback time; no warm transfer is available',
          };
          break;
        case 'end_call':
          if (this.flow.stage !== 'WRAP_UP')
            throw new Error('Complete required flow before ending');
          result = { ending: true };
          break;
        default:
          throw new Error('Unknown tool');
      }
    } catch (error) {
      if (call.name === 'mark_do_not_call') throw error;
      result = { error: error instanceof Error ? error.message : 'Invalid tool arguments' };
    }
    const entry = {
      name: call.name,
      args: redactSensitive(JSON.stringify(call.args), this.campaign.type === 'hr'),
      result,
      at: new Date().toISOString(),
    };
    this.tools.push(entry);
    this.hooks.event('tool', entry);
    this.hooks.event('fields', this.fields);
    return result;
  }
  private async say(text: string, timing?: CallResult['latency'][number], endAt?: number, onFirstAudio?: () => void) {
    if (!text.trim()) return;
    const signal = this.abort.signal,
      frames = new FrameBuffer(160),
      began = Date.now();
    const context = this.responseContext?.generation === this.generation ? this.responseContext : undefined;
    timing ??= context?.timing;
    endAt ??= context?.endAt;
    const voice = this.campaign.voice[this.language as Campaign['languages'][number]] ?? 'Shivani';
    if (timing) timing.tts_cache_hit = this.speech.has(text, this.language, voice);
    let first = true;
    this.busy = true;
    if (this.hooks.usage && !(await this.hooks.usage(this.sttSeconds, this.ttsChars)))
      throw new Error('Usage cap reached');
    this.record('agent', text);
    for await (const chunk of this.speech.synthesize(text, this.language, voice, signal)) {
      if (signal.aborted) return;
      if (first) {
        first = false;
        onFirstAudio?.();
        if (timing) {
          timing.tts_first_byte_ms = Date.now() - began;
          if (context) timing.stt_final_to_audio_ms = Date.now() - context.finalAt;
          if (endAt) timing.end_of_speech_to_audio_ms = Date.now() - endAt;
          if (!this.latency.includes(timing)) {
            this.latency.push(timing);
            this.hooks.event('latency', timing);
          }
        }
      }
      for (const frame of frames.push(chunk)) this.transport.audio(frame);
    }
    for (const frame of frames.flush(255)) this.transport.audio(frame);
    for (let i = 0; i < 2; i++) this.transport.audio(Buffer.alloc(160, 255));
    await this.transport.mark(`turn-${this.generation}`);
    this.busy = false;
  }
  finish(outcome?: Outcome, source = 'pipeline'): Promise<void> {
    if (this.finishing) return this.finishing;
    this.hooks.event('call_end', {
      source,
      requested_outcome: outcome,
      stage: this.flow.stage,
      caller_turns: this.transcript.filter((turn) => turn.role === 'caller').length,
    });
    this.finishing = this.finalize(outcome, source);
    return this.finishing;
  }
  private async finalize(outcome: Outcome | undefined, source: string) {
    clearTimeout(this.duration);
    clearTimeout(this.idle);
    this.resolveIntro();
    this.abort.abort();
    this.stt.close();
    this.speech.close();
    const completed = this.flow.stage === 'WRAP_UP';
    const finalOutcome =
      outcome ??
      this.outcome ??
      (this.campaign.type === 'hr' && completed
        ? 'CANDIDATE_COMPLETED'
        : this.interest === 'hot'
          ? 'INTERESTED_HOT'
          : this.interest === 'warm'
            ? 'INTERESTED_WARM'
            : 'INCOMPLETE');
    let postCall: Awaited<ReturnType<typeof analyzeCall>> | undefined;
    if (!this.simulation && this.transcript.some((turn) => turn.role === 'caller')) {
      try {
        postCall = await analyzeCall(this.campaign, this.transcript, finalOutcome, this.fields);
        this.tokens += postCall.tokens;
        this.provider(this.dialogue.name, 'post-call analysis complete');
      } catch {
        this.provider(this.dialogue.name, 'post-call analysis unavailable; saved transcript retained');
      }
    }
    const result: CallResult = {
      campaign_id: this.campaignId,
      contact_id: this.contactId,
      outcome: finalOutcome,
      end_reason: source,
      summary: postCall?.summary ?? (!this.transcript.some((turn) => turn.role === 'caller')
        ? 'The call ended before any caller response was captured. Interest and qualification answers are unknown.'
        : `${this.simulation ? '[SIMULATION] ' : ''}${this.campaign.type === 'hr' ? 'Advisory screening' : 'Campaign call'} ended at ${this.flow.stage}.\n${
        Object.entries(this.fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n') || 'No qualification fields captured.'
      }\nHuman review required.`),
      extracted_fields: this.fields,
      sentiment: 'unknown',
      languages: [...this.spokenLanguages],
      transcript: this.transcript,
      tool_log: this.tools,
      latency: this.latency,
      usage: {
        stt_seconds: this.sttSeconds,
        tts_chars: this.ttsChars,
        llm_tokens: this.tokens,
        telephony_minutes: this.contactId ? (Date.now() - this.started) / 60000 : 0,
      },
      provider_trace: this.trace,
      agent_version: agentVersion(this.campaign),
      sample: this.campaign.sample,
      simulation: this.simulation,
      duration_s: (Date.now() - this.started) / 1000,
      follow_up_eligible: false,
    };
    if (this.campaign.type === 'hr') {
      result.eligibility = eligibility(this.campaign, this.fields);
      result.recommendation = postCall?.job_related_comments
        ? `${postCall.job_related_comments} Human review required.`
        : 'Review the job-related answers and transcript. A human makes the hiring decision.';
    }
    result.follow_up_eligible = shouldSubmit(result);
    await this.hooks.complete(result);
    this.hooks.event('result', result);
    await this.transport.end();
  }
}
