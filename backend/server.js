require("dotenv").config()
const pool = require("./db")
pool
  .query("SELECT NOW()")
  .then(() => console.log("Database connected successfully"))
  .catch(err => console.error("Database connection failed:", err.message))
const express = require("express")

const app = express()
app.use(express.json())
function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"]

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      error: "Unauthorized: Invalid or missing API key",
    })
  }

  next()
}

const PORT = process.env.PORT ||

app.post("/reset",requireApiKey, async (req, res) => {
  const { slots } = req.body

  if (!Array.isArray(slots)) {
    return res.status(400).json({
      error: "Slots must be an array",
    })
  }

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    await client.query("DELETE FROM public.bookings")
    await client.query('DELETE FROM public."Slots"')

    for (const slot of slots) {
      await client.query(
        `INSERT INTO public."Slots" (id, provider, start, "end")
         VALUES ($1, $2, $3, $4)`,
        [slot.id, slot.provider, slot.start, slot.end]
      )
    }

    await client.query("COMMIT")

    res.json({
      message: "Slots reset successfully",
      slots_created: slots.length,
    })
  } catch (error) {
    await client.query("ROLLBACK")
    console.error(error)

    res.status(500).json({
      error: "Failed to reset slots",
    })
  } finally {
    client.release()
  }
})

app.get("/slots", requireApiKey, async (req, res) => {
  try {
    const {provider} = req.query;

    const result = await pool.query(`
      SELECT
        s.id,
        s.provider,
        s.start,
        s."end",
        NOT EXISTS (
          SELECT 1
          FROM bookings b
          WHERE b.slot_id = s.id
          AND b.status = 'confirmed'
        ) AS available
      FROM public."Slots" s
      WHERE ($1::text IS NULL OR s.provider = $1::text)
      ORDER BY s.start ASC
    `, [provider || null])

    res.json({ slots: result.rows })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to fetch slots" })
  }
})

app.get("/public/slots", async (req, res) => {
  try {
    const { provider } = req.query

    const result = await pool.query(`
      SELECT
        s.id,
        s.provider,
        s.start,
        s."end",
        NOT EXISTS (
          SELECT 1
          FROM public.bookings b
          WHERE b.slot_id = s.id
          AND b.status = 'confirmed'
        ) AS available
      FROM public."Slots" s
      WHERE ($1::text IS NULL OR s.provider = $1::text)
      ORDER BY s.start ASC
    `, [provider || null])

    res.json({ slots: result.rows })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to fetch slots" })
  }
})

async function checkRateLimit(email) {
  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    // Prevent simultaneous requests from bypassing the limit
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email])

    const result = await client.query(
      `SELECT COUNT(*) AS total, MIN(attempted_at) AS oldest
       FROM public.booking_attempts
       WHERE email = $1
       AND attempted_at > NOW() - INTERVAL '1 minute'`,
      [email]
    )

    const total = Number(result.rows[0].total)

    if (total >= 5) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(result.rows[0].oldest).getTime() + 60000 - Date.now()) / 1000)
      )

      await client.query("COMMIT")

      return { limited: true, retryAfter }
    }

    await client.query("INSERT INTO public.booking_attempts (email) VALUES ($1)", [email])

    await client.query("COMMIT")

    return { limited: false }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

async function createBooking(req, res) {
  try {
    const { slot_id, name, email } = req.body

    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : ""

    if (cleanEmail) {
      const rateLimit = await checkRateLimit(cleanEmail)

      if (rateLimit.limited) {
        res.set("Retry-After", String(rateLimit.retryAfter))

        return res.status(429).json({
          error: "Too many booking attempts. Please try again later.",
        })
      }
    }

    const idempotencyKey = req.headers["idempotency-key"]

    if (idempotencyKey) {
      const existingRequest = await pool.query(
        "SELECT * FROM public.idempotency_keys WHERE key = $1",
        [idempotencyKey]
      )

      if (existingRequest.rows.length > 0) {
        const saved = existingRequest.rows[0]

        if (
          saved.request_body.slot_id !== req.body.slot_id ||
          saved.request_body.name !== req.body.name ||
          saved.request_body.email !== req.body.email
        ) {
          return res.status(422).json({
            error: "Idempotency key was already used with a different request",
          })
        }

        return res.status(saved.status_code).json(saved.response_body)
      }
    }

    if (!slot_id || !name?.trim() || !email?.trim()) {
      return res.status(400).json({
        error: "slot_id, name and email are required",
      })
    }

    const cleanName = name.trim()

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "Invalid email address" })
    }

    const slotResult = await pool.query(
      'SELECT * FROM public."Slots" WHERE id = $1',
      [slot_id]
    )

    if (slotResult.rows.length === 0) {
      return res.status(404).json({ error: "Slot not found" })
    }

    const slot = slotResult.rows[0]

    if (new Date(slot.start) <= new Date()) {
      return res.status(400).json({ error: "Appointment has already started" })
    }

    const bookingId = require("crypto").randomUUID()

    const result = await pool.query(
      `INSERT INTO public.bookings (id, slot_id, name, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING *`,
      [bookingId, slot_id, cleanName, cleanEmail]
    )

    if (result.rows.length === 0) {
      return res.status(409).json({ error: "Slot is already booked" })
    }

    const booking = result.rows[0]

    if (idempotencyKey) {
      await pool.query(
        `INSERT INTO public.idempotency_keys
         (key, request_body, response_body, status_code)
         VALUES ($1, $2, $3, $4)`,
        [idempotencyKey, req.body, booking, 201]
      )
    }

    res.status(201).json(booking)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to create booking" })
  }
}
app.post("/bookings", requireApiKey, createBooking)
app.post("/public/bookings", createBooking)

app.get("/bookings", requireApiKey, async (req, res) => {
  try {
    const email = req.query.email?.trim().toLowerCase()
    const limit = Number(req.query.limit) || 10
    const cursor = req.query.cursor

    if (!email) {
      return res.status(400).json({ error: "Email is required" })
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ error: "Limit must be between 1 and 50" })
    }

    let query
    let values

    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"))

      query = `
        SELECT *,
        TO_CHAR(created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM public.bookings
        WHERE LOWER(email) = $1
        AND (created_at, id) > ($2::timestamptz, $3)
        ORDER BY created_at ASC, id ASC
        LIMIT $4
      `

      values = [email, decoded.created_at, decoded.id, limit + 1]
    } else {
      query = `
        SELECT *,
        TO_CHAR(created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM public.bookings
        WHERE LOWER(email) = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
      `

      values = [email, limit + 1]
    }

    const result = await pool.query(query, values)

    const hasMore = result.rows.length > limit
    const bookings = result.rows.slice(0, limit)

    let next_cursor = null

    if (hasMore) {
      const lastBooking = bookings[bookings.length - 1]

      next_cursor = Buffer.from(
        JSON.stringify({
          created_at: lastBooking.cursor_created_at,
          id: lastBooking.id,
        })
      ).toString("base64")
    }

    const cleanBookings = bookings.map(({ cursor_created_at, ...booking }) => booking)

    res.json({ bookings: cleanBookings, next_cursor })
  } catch (error) {
    console.error("Pagination error:", error.message)
    console.error(error)
    res.status(400).json({ error: "Invalid cursor or failed to fetch bookings" })
  }
})

app.get("/bookings/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query("SELECT * FROM public.bookings WHERE id = $1", [id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to fetch booking" })
  }
})

app.delete("/bookings/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      `UPDATE public.bookings
       SET status = 'cancelled'
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *`,
      [id]
    )

    if (result.rows.length > 0) {
      return res.json(result.rows[0])
    }

    // Check whether the booking exists
    const check = await pool.query("SELECT status FROM public.bookings WHERE id = $1", [id])

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" })
    }

    return res.status(409).json({ error: "Booking is already cancelled" })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to cancel booking" })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
