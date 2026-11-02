# 수업 응답 웹앱 · 버전 2 (교사 + 학생)

선생님이 수업에서 직접 쓰는 판입니다. 가입·초대 코드·운영자 기능이 없고, **교사와 학생**만 있습니다.

- **교사**: 이메일과 비밀번호로 로그인. 슬라이드 수업 또는 설문만 만들기, PDF 슬라이드 올리기, 질문·설문·퀴즈 만들기, 수업 진행(접속한 학생 이름 보기), 학생 관리.
- **학생**: 수업 코드 + 이름. 로그인은 없고, 입장한 기기에 저장된 열쇠로 다시 들어옵니다. 큰 화면에서는 슬라이드와 질문이 나란히 보입니다.

## 미리 해 보기 (인터넷 없이)
`class-platform-trial` 폴더의 **버전2 체험하기.bat**을 더블클릭하세요. 교사 이메일 `lihyosong@gmail.com`, 비밀번호 `trial1234`.

## 실제로 쓰기

### 1. Supabase
1. [supabase.com](https://supabase.com) → **New project** (Region: Northeast Asia (Seoul)).
2. `setup.sql` 맨 아래 교사 이메일을 확인(지금은 `lihyosong@gmail.com`)하고, 파일 전체를 **SQL Editor**에 붙여넣어 **Run**. 경고 창이 나오면 그대로 실행.
3. **Authentication → Users → Add user → Create new user**: 그 이메일과 비밀번호, **Auto Confirm User** 체크.
4. **Authentication → Sign In / Providers**에서 **Allow new users to sign up**을 끕니다(교사 계정은 3번처럼 직접 만듭니다).
5. **Project Settings → API Keys / Data API**(또는 위쪽 **Connect**)에서 Project URL과 **publishable 키**를 복사해 `config.js`에 넣습니다. secret 키는 절대 넣지 마세요.

### 2. 사이트 올리기
GitHub Pages: 새 저장소 → 이 폴더 안의 파일과 `vendor` 폴더 올리기 → Settings → Pages → `main` / `(root)`.
- 교사 화면: `https://…/teacher.html`
- 학생 화면: 교사 화면의 **학생 접속 주소·QR**

### 3. 수업 만들기
1. **수업 설정 → 새로 만들기**에서 **슬라이드 수업** 또는 **설문만**을 고르고 제목을 넣습니다. 수업 코드는 자동으로 생깁니다.
2. 슬라이드 수업이면 PowerPoint에서 「다른 이름으로 저장 → PDF」 한 파일을 올립니다(100쪽까지).
3. **질문·설문 만들기**에서 질문을 만들고, **수업 진행**에서 QR을 띄웁니다.
4. 다른 반은 **다른 반용으로 복제**.

## 알아 둘 것
- 입력한 이름이 본인인지 확인하지 않습니다. 성적에 반영할 활동이면 명단과 대조하세요. 다른 기기나 시크릿 창에서 들어오면 같은 이름이어도 새 학생이 되어, 앞서 쓴 답을 볼 수 없고 퀴즈도 다시 제출할 수 있습니다.
- 학생 이름과 응답이 선생님 Supabase에 저장됩니다. 수업이 끝나면 CSV로 내려받아 두고, 필요 없으면 수업을 지우세요.
- 무료 프로젝트는 1주일 동안 쓰지 않으면 일시 정지됩니다. 대시보드에서 Restore.
- 교사 이메일을 더 넣으면(setup.sql 맨 아래 줄 추가 후 다시 Run, 3번처럼 계정 만들기) 여러 선생님이 같은 수업들을 함께 관리합니다.
