import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

/** Local auth/catalog contract. No real email is sent and no shared account is created. */
export class B2cServer {
  private server?: Server;
  private url = '';
  private users = new Map<string, { name: string; password: string; verified: boolean; profile: boolean; joined: boolean }>();
  private tokens = new Map<string, string>();
  private settings = { confirmation: false, profileFailure: false, unavailable: false, institute: false };
  private signups = 0;
  private recovery?: {email: string; challenge: string; code: string; link: string};
  async start() {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as { port: number };
    return this.url = `http://127.0.0.1:${address.port}`;
  }
  stop() { this.server?.close(); }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const url = new URL(request.url!, this.url), path = url.pathname;
    const send = (status: number, data: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    const token = (request.headers.authorization ?? '').replace('Bearer ', '');
    const email = this.tokens.get(token), user = email ? this.users.get(email) : undefined;
    const session = (email: string) => {
      const token = `token-${email}`;
      this.tokens.set(token, email);
      return { access_token: token, refresh_token: 'refresh', expires_in: 3600,
        user: { id: email, email, user_metadata: { learner_type: 'individual', name: this.users.get(email)!.name } } };
    };
    if (path === '/__state') return send(200, { signups: this.signups, users: [...this.users].map(([email, u]) => ({ email, verified: u.verified, profile: u.profile, joined: u.joined })) });
    if (path === '/__settings') { Object.assign(this.settings, body); return send(200, {}); }
    if (path === '/__verify') { this.users.get(body.email)!.verified = true; return send(200, {}); }
    if (path === '/__recovery') return send(200, {link: this.recovery?.link});
    if (path === '/auth/v1/recover') {
      if (request.headers.apikey !== 'test-anon-key' || body.code_challenge_method !== 's256') return send(400, {});
      if (this.users.has(body.email)) {
        const code = randomUUID(), link = new URL(url.searchParams.get('redirect_to')!);
        link.searchParams.set('code', code);
        this.recovery = {email: body.email, challenge: body.code_challenge, code, link: link.href};
      }
      return send(200, {});
    }
    if (path === '/auth/v1/user' && request.method === 'PUT') {
      if (!user || typeof body.password !== 'string' || body.password.length < 8) return send(401, {});
      user.password = body.password;
      return send(200, {id: email, email});
    }
    if (path === '/auth/v1/signup') {
      this.signups++;
      if (this.users.has(body.email)) return send(200, { user: { identities: [] } });
      this.users.set(body.email, { name: body.data.name, password: body.password, verified: !this.settings.confirmation, profile: false, joined: false });
      return send(200, this.settings.confirmation ? { user: { id: body.email } } : session(body.email));
    }
    if (path === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'pkce') {
        const recovery = this.recovery;
        if (!recovery || body.auth_code !== recovery.code || typeof body.code_verifier !== 'string'
            || createHash('sha256').update(body.code_verifier).digest('base64url') !== recovery.challenge) return send(400, {msg: 'Invalid recovery proof'});
        this.recovery = undefined;
        return send(200, session(recovery.email));
      }
      const account = this.users.get(body.email);
      if (!account || account.password !== body.password) return send(400, { msg: 'Invalid login credentials' });
      if (!account.verified) return send(400, { msg: 'Email not confirmed' });
      return send(200, session(body.email));
    }
    if (path === '/auth/v1/logout') { this.tokens.delete(token); return send(200, {}); }
    if (path === '/rest/v1/rpc/public_learning_catalog') {
      if (this.settings.unavailable) return send(404, { code: 'PGRST202' });
      return send(200, { individual: !!user?.profile && !this.settings.institute, courses: [{ id: 'python', title: 'Python', summary: 'Learn with practice.',
        level: 'Beginner', prerequisites: 'None', can_join: true, enrolled: !!user?.joined && !this.settings.institute,
        chapters: [{ id: '10000000-0000-0000-0000-000000000001', name: 'Lists', lesson: 'Indexing', free: true },
          { id: '10000000-0000-0000-0000-000000000002', name: 'Loops', lesson: 'For loops', free: false }] }],
        offers: [{id:'python-once',title:'Python access',amount:49900,currency:'INR',course_ids:['python'],owned:false},
          {id:'bundle',title:'Programming bundle',amount:79900,currency:'INR',course_ids:['python','build-an-llm'],owned:false}] });
    }
    if (path === '/rest/v1/rpc/complete_individual_signup') {
      if (!user?.verified) return send(403, { message: 'Verify your email.' });
      if (this.settings.profileFailure) return send(503, { message: 'Please retry profile setup.' });
      user.profile = true;
      return send(200, { learner_type: 'individual' });
    }
    if (path === '/rest/v1/rpc/join_learning_course') {
      if (!user?.profile || body.p_course !== 'python') return send(403, { message: 'Course unavailable' });
      user.joined = true;
      return send(200, { course_id: 'python', enrolled: true });
    }
    if (path === '/learning-billing/purchases') return send(200, {payments_ready:true,purchases:[]});
    if (path === '/notebook-coach/study') return send(200, {courses:user?.joined && !this.settings.institute
      ? [{id:'python',title:'Python',chapters:[{id:'10000000-0000-0000-0000-000000000001',title:'Lists'}]}] : []});
    if (path === '/notebook-coach/exercises') return send(200, { courses: user?.joined && !this.settings.institute ? [{ name: 'Python', chapters: [
      { id: '10000000-0000-0000-0000-000000000001', name: 'Lists', locked:false,
        progress:{status:'covered',covered:1,total:1,topics:[{id:'indexing',title:'Indexing',status:'covered'}]} },
      { id: '10000000-0000-0000-0000-000000000002', name: 'Loops', locked:true,
        progress:{status:'not_started',covered:0,total:1,topics:[{id:'for',title:'For loops',status:'not_started'}]} }] }] : [], languages: [{ id: 'python', name: 'Python' }] });
    return send(404, { error: 'Unknown test route' });
  }
}
