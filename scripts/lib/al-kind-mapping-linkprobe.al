report 50000 "Link Probe"
{
    dataset
    {
        dataitem(Header; "Sales Header")
        {
            column(No; "No.") { }

            dataitem(Line; "Sales Line")
            {
                DataItemLink = "Document No." = field("No.");
                DataItemTableView = sorting("Document No.");

                column(Amount; Amount) { }
            }
        }
    }
}
