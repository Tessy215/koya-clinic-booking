import { useEffect, useState } from "react"

function App() {
  const [slots, setSlots] = useState([])
  const [selectedSlot, setSelectedSlot] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [booking, setBooking] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch("/public/slots")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load appointments")
        return res.json()
      })
      .then((data) => setSlots(data.slots))
      .catch(() => setError("Unable to load appointment slots"))
  }, [])

  async function handleBooking(e) {
    e.preventDefault()
    setError("")
    setBooking(null)
    setLoading(true)

    try {
      const response = await fetch("/public/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot_id: selectedSlot,
          name,
          email,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Booking failed")
      }

      setBooking(data)
      setSelectedSlot("")
      setName("")
      setEmail("")

      const slotsResponse = await fetch("/public/slots")
      const slotsData = await slotsResponse.json()
      setSlots(slotsData.slots)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main>
      <h1>Clinic Appointment Booking</h1>
      <p>Choose an available appointment and book your visit.</p>

      {error && <p>{error}</p>}

      {booking && (
        <section>
          <h2>Booking Confirmed!</h2>
          <p>Booking ID: {booking.id}</p>
          <p>Patient: {booking.name}</p>
          <p>Email: {booking.email}</p>
          <p>Status: {booking.status}</p>
        </section>
      )}

      <form onSubmit={handleBooking}>
        <h2>Book an Appointment</h2>

        <label>
          Available appointments
          <select
            value={selectedSlot}
            onChange={(e) => setSelectedSlot(e.target.value)}
            required
          >
            <option value="">Select an appointment</option>
            {slots.filter((slot) => slot.available).map((slot) => (
              <option key={slot.id} value={slot.id}>
                {slot.provider} — {new Date(slot.start).toLocaleString()}
              </option>
            ))}
          </select>
        </label>

        <label>
          Full name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={loading}>
          {loading ? "Booking..." : "Book Appointment"}
        </button>
      </form>
    </main>
  )
}

export default App