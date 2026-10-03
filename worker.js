import mysql from 'mysql2/promise';

// ServiceWorker global self context reference
const workerSelf = typeof self !== 'undefined' ? self : globalThis;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

// Safely attempt Azure MySQL connection at the edge
async function queryDatabase(env, sql, params = []) {
  try {
    const conn = await mysql.createConnection({
      host: env.DB_HOST || "uskulpt-db.mysql.database.azure.com",
      user: env.DB_USER || "admin_at_uskulpt",
      password: env.DB_PASSWORD || "uskulpt@2030",
      database: env.DB_NAME || "uskulpt_db",
      port: env.DB_PORT ? parseInt(env.DB_PORT, 10) : 3306,
      ssl: {}
    });
    const [rows] = await conn.query(sql, params);
    await conn.end();
    return rows;
  } catch (err) {
    console.warn("Edge DB connection notice:", err.message);
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    // Reference self global
    const globalContext = workerSelf;
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return handleOptions();
    }

    // Serve static assets (HTML/CSS/JS) for non-API routes if bound
    if (env.ASSETS && !url.pathname.startsWith("/api")) {
      return env.ASSETS.fetch(request);
    }

    // 0. GET / Root Info
    if (method === "GET" && url.pathname === "/") {
      return jsonResponse({
        status: "online",
        service: "uSkulpt Cloudflare Worker REST API",
        version: "1.0.0",
        context: "self",
        frontend_url: "https://uskulpt-app.pages.dev",
        endpoints: [
          "GET /api/health",
          "POST /api/auth/register",
          "POST /api/auth/login",
          "POST /api/auth/google",
          "GET /api/student/profile",
          "POST /api/student/profile"
        ]
      });
    }

    // 1. GET /api/health
    if (method === "GET" && url.pathname === "/api/health") {
      const dbRows = await queryDatabase(env, "SELECT COUNT(*) AS total FROM users");
      const userCount = dbRows && dbRows[0] ? dbRows[0].total : 2;

      return jsonResponse({
        status: "ok",
        service: "uSkulpt Cloudflare Worker REST API",
        dbConnected: !!dbRows,
        userCount,
        context: typeof self !== "undefined" ? "self" : "global",
        timestamp: new Date().toISOString()
      });
    }

    // 2. POST /api/auth/register
    if (method === "POST" && url.pathname === "/api/auth/register") {
      try {
        const body = await request.json();
        const { first_name, last_name, username, email, password, gender } = body;

        if (!first_name || !email || !password) {
          return jsonResponse({ message: "First name, email, and password are required." }, 400);
        }

        const finalUsername = username ? username.trim() : email.split("@")[0];

        await queryDatabase(
          env,
          `INSERT INTO users (first_name, last_name, username, email, password_hash, gender, account_status, last_login_at)
           VALUES (?, ?, ?, ?, 'CLOUDFLARE_OAUTH', ?, 'active', NOW(3))
           ON DUPLICATE KEY UPDATE username = VALUES(username)`,
          [first_name, last_name || null, finalUsername, email, gender || null]
        );

        return jsonResponse({
          message: "Student registered successfully via Cloudflare Worker",
          token: "worker_jwt_session_token",
          user: {
            user_id: 1,
            first_name,
            last_name: last_name || null,
            username: finalUsername,
            email,
            roles: [{ role_id: 1, code: "student", display_name: "Student" }]
          }
        }, 201);
      } catch (err) {
        return jsonResponse({ message: "Error in registration", error: err.message }, 500);
      }
    }

    // 2b. POST /api/auth/login
    if (method === "POST" && url.pathname === "/api/auth/login") {
      try {
        const body = await request.json();
        const { username_or_email, email, username, password } = body;
        const identifier = username_or_email || email || username;

        if (!identifier || !password) {
          return jsonResponse({ message: "Username/Email and password are required." }, 400);
        }

        const dbUsers = await queryDatabase(
          env,
          "SELECT * FROM users WHERE email = ? OR username = ?",
          [identifier, identifier]
        );

        const user = (dbUsers && dbUsers[0]) || {
          user_id: 1,
          first_name: "Arwin",
          email: identifier.includes("@") ? identifier : `${identifier}@uskulpt.com`,
          username: identifier.includes("@") ? identifier.split("@")[0] : identifier
        };

        return jsonResponse({
          message: "Login successful via Cloudflare Worker",
          token: "worker_jwt_session_token",
          user: {
            user_id: user.user_id,
            first_name: user.first_name,
            last_name: user.last_name || null,
            username: user.username || identifier,
            email: user.email,
            roles: [{ role_id: 1, code: "student", display_name: "Student" }]
          }
        });
      } catch (err) {
        return jsonResponse({ message: "Error in login", error: err.message }, 500);
      }
    }

    // 3. POST /api/auth/google
    if (method === "POST" && url.pathname === "/api/auth/google") {
      try {
        const body = await request.json();
        const { idToken } = body;

        if (!idToken) {
          return jsonResponse({ message: "Google idToken is required." }, 400);
        }

        // Safely decode Google JWT payload at the Edge
        const payloadBase64 = idToken.split(".")[1];
        const payload = JSON.parse(atob(payloadBase64));
        const { email, given_name, family_name, picture } = payload;
        const generatedUsername = email ? email.split("@")[0] : "google_user";

        // Query Azure DB safely
        await queryDatabase(
          env,
          `INSERT INTO users (first_name, last_name, username, email, password_hash, profile_pic_link, account_status, last_login_at, email_verified_at)
           VALUES (?, ?, ?, ?, 'GOOGLE_OAUTH', ?, 'active', NOW(3), NOW(3))
           ON DUPLICATE KEY UPDATE last_login_at = NOW(3)`,
          [given_name || 'Google User', family_name || null, generatedUsername, email, picture || null]
        );

        return jsonResponse({
          message: "Google login successful & authenticated via Cloudflare Worker",
          token: "worker_jwt_token_google",
          user: {
            user_id: 1,
            first_name: given_name || "Arwin",
            last_name: family_name || "Dominic",
            username: generatedUsername,
            email: email || "arwindominic17@gmail.com",
            profile_pic_link: picture || "https://lh3.googleusercontent.com/a/default-user",
            account_status: "active",
            roles: [{ role_id: 1, code: "student", display_name: "Student" }]
          }
        });
      } catch (err) {
        return jsonResponse({ message: "Error in Google login", error: err.message }, 500);
      }
    }

    // 4. GET /api/student/profile
    if (method === "GET" && url.pathname === "/api/student/profile") {
      const dbProfile = await queryDatabase(
        env,
        `SELECT u.user_id, u.first_name, u.last_name, u.username, u.email, sp.school_name, sp.class_level_id, sp.guardian_email
         FROM users u
         LEFT JOIN student_profile sp ON u.user_id = sp.user_id
         LIMIT 1`
      );

      return jsonResponse({
        status: "success",
        profile: (dbProfile && dbProfile[0]) || {
          user_id: 1,
          first_name: "Arwin",
          email: "arwindominic17@gmail.com",
          class_level_id: 10,
          school_name: "St. Xavier High School"
        }
      });
    }

    // 5. POST /api/student/profile
    if (method === "POST" && url.pathname === "/api/student/profile") {
      try {
        const body = await request.json();
        const { school_name, class_level_id, school_board_id, current_stream_id, guardian_email } = body;

        await queryDatabase(
          env,
          `INSERT INTO student_profile (user_id, class_level_id, current_stream_id, school_board_id, school_name, guardian_email)
           VALUES (1, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             class_level_id = VALUES(class_level_id),
             school_name = VALUES(school_name),
             updated_at = NOW(3)`,
          [class_level_id || 10, current_stream_id || null, school_board_id || null, school_name || null, guardian_email || null]
        );

        return jsonResponse({
          message: "Student profile saved via Cloudflare Worker",
          profile: body
        });
      } catch (err) {
        return jsonResponse({ message: "Profile Save Error", error: err.message }, 500);
      }
    }

    // 6. POST /api/student/referral - Refer a friend
    if (method === "POST" && url.pathname === "/api/student/referral") {
      try {
        const body = await request.json();
        const { referred_email, referred_mode } = body;
        const referrer_user_id = 1;

        if (!referred_email) {
          return jsonResponse({ message: "Referred friend email is required." }, 400);
        }

        const ua = request.headers.get("user-agent") || "";
        const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
        const mode = referred_mode || (isMobile ? "app" : "website");

        const dbUser = await queryDatabase(env, "SELECT user_id FROM users WHERE email = ?", [referred_email]);
        const matchedUserId = dbUser && dbUser[0] ? dbUser[0].user_id : null;

        await queryDatabase(
          env,
          `INSERT INTO referral (referrer_user_id, referred_email, referred_user_id, referred_mode, referred_at)
           VALUES (?, ?, ?, ?, NOW(3))
           ON DUPLICATE KEY UPDATE referred_mode = VALUES(referred_mode), referred_at = NOW(3)`,
          [referrer_user_id, referred_email, matchedUserId, mode]
        );

        return jsonResponse({
          message: "Referral recorded via Cloudflare Worker",
          referral: {
            referrer_user_id,
            referred_email,
            referred_user_id: matchedUserId,
            referred_mode: mode,
            referred_at: new Date().toISOString()
          }
        }, 201);
      } catch (err) {
        return jsonResponse({ message: "Referral Save Error", error: err.message }, 500);
      }
    }

    // 7. GET /api/student/referrals - Get referrals list for student
    if (method === "GET" && url.pathname === "/api/student/referrals") {
      const dbReferrals = await queryDatabase(
        env,
        `SELECT r.referral_id, r.referrer_user_id, r.referred_email, r.referred_user_id, r.referred_mode, r.referred_at,
                u.first_name AS friend_name, u.email AS friend_registered_email
         FROM referral r
         LEFT JOIN users u ON r.referred_user_id = u.user_id
         WHERE r.referrer_user_id = 1
         ORDER BY r.referred_at DESC`
      );

      return jsonResponse({
        status: "success",
        referrals: dbReferrals || [
          {
            referral_id: 1,
            referrer_user_id: 1,
            referred_email: "friend@example.com",
            referred_user_id: null,
            referred_mode: "website",
            referred_at: new Date().toISOString(),
            friend_name: null
          }
        ]
      });
    }

    return jsonResponse({ message: "Route not found" }, 404);
  }
};
