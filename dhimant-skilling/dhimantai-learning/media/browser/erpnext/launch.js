/* Same-origin handoff: identity survives login without a nested query string. */
(async () => {
  const status = document.getElementById('status');
  const params=new URLSearchParams(location.hash.slice(1));
  let learner = params.get('learner');
  if (learner) {
    sessionStorage.setItem('dhimantai-erpnext-learner', learner);
    const port=Number(params.get('bridge')),token=params.get('token');
    if(Number.isInteger(port) && port>0 && port<=65535 && /^[a-f0-9]{64}$/.test(token||'')) {
      sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:'+port,token,learner}));
    } else sessionStorage.removeItem('dhimantai-erpnext-instructor');
    // Drop the launch secret from the address bar and history.
    history.replaceState(null,'',location.pathname);
  } else learner = sessionStorage.getItem('dhimantai-erpnext-learner');
  if (!/^[a-f0-9]{20}$/.test(learner || '')) {
    status.textContent = 'Reopen this course from dhimantAI.';
    return;
  }
  // dhimantAI holds this computer's training password; sign in without asking the learner to paste it.
  try {
    const connection=JSON.parse(sessionStorage.getItem('dhimantai-erpnext-instructor')||'null');
    if(connection && connection.learner===learner && /^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)) {
      const credentials=await fetch(connection.origin+'/signin',{method:'POST',headers:{Authorization:'Bearer '+connection.token},cache:'no-store',signal:AbortSignal.timeout(9000)});
      if(credentials.ok) {
        const {usr,pwd}=await credentials.json();
        const login=await fetch('/api/method/login',{method:'POST',credentials:'same-origin',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({usr,pwd})});
        if(login.ok) {location.replace('/desk');return;}
      }
    }
  } catch {}
  status.textContent = 'Opening ERPNext sign-in…';
  location.replace('/login?redirect-to=/desk');
})();
